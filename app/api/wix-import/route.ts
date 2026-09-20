import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase-server';
import { nameSizeKey, tidyName } from '@/lib/types';

// Reconciles the Wix catalogue against stock_items: links existing
// tracker lines to their Wix product and variant, brings prices across,
// and creates a line for any Wix size the tracker does not have yet.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
// It never writes `quantity` on a row that already exists. The previous
// version upserted on (name, size) with `quantity: 0` in the payload,
// which on a match would have zeroed the real cupboard count — 19 units
// of Womens One Day Playing Shirt, 13 of Womens pants, and so on. Rows
// it creates start at 0 because Wix knows what is for sale, not what is
// in the cupboard; rows that already exist keep whatever the last
// stocktake said.
//
// It also never touches name, size, category, low_stock_alert or
// target_level on an existing row. Only wix_product_id, wix_variant_id
// and price are reconciled, which is exactly the set migration
// 20260920000007 lets a service-role caller through
// check_stock_item_update for. Anything outside that set is refused by
// the database, not merely avoided here.
//
// MATCHING is by name + size, normalised through nameSizeKey() so the
// tracker's short sizes line up with whatever Wix spells out. That is
// the same key wix-sync falls back to, shared from lib/types.ts so the
// two cannot drift: a size that imports under one spelling and syncs
// under another creates a line that silently never receives orders.
//
// DRY RUN: ?dryRun=1 performs every read and every comparison, writes
// nothing, and returns the exact same report. Run it first.

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface WixVariant {
  id?: string;
  choices?: Record<string, string>;
  variant?: { priceData?: { price?: number }; sku?: string };
}

interface WixProduct {
  id: string;
  name?: string;
  productType?: string;
  priceData?: { price?: number };
  productOptions?: Array<{ name?: string; choices?: Array<{ value?: string }> }>;
  variants?: WixVariant[];
}

interface StockRow {
  id: string;
  name: string;
  size: string;
  price: number | string;
  quantity: number;
  wix_product_id: string | null;
  wix_variant_id: string | null;
}

/** One Wix catalogue entry: a product/size pair and what it costs. */
interface CatalogueEntry {
  productId: string;
  productName: string;
  size: string;
  variantId: string | null;
  price: number;
}

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

function guessCategory(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('cap') || n.includes('hat') || n.includes('baggy')) return 'Cap';
  if (n.includes('hoodie') || n.includes('hoody')) return 'Hoodie';
  if (n.includes('jacket') || n.includes('vest')) return 'Jacket';
  if (n.includes('short')) return 'Shorts';
  if (n.includes('shirt') || n.includes('tee') || n.includes('polo') || n.includes('top'))
    return 'T-Shirt';
  return 'Other';
}

// Fees, memberships and registrations are not merchandise.
function looksLikeAFee(name: string): boolean {
  const n = name.toLowerCase();
  return /\b(fee|fees|subs|subscription|registration|rego|membership|levy|donation)\b/.test(n);
}

// Flattens a Wix product into one entry per size. A product with no
// size option yields a single "One size" entry with no variant id,
// which is how an unsized product has always been represented here.
function catalogueEntries(p: WixProduct): CatalogueEntry[] {
  const productName = tidyName(p.name ?? '');
  const basePrice = p.priceData?.price ?? 0;

  const sizeOption = (p.productOptions ?? []).find((o) => /size/i.test(o.name ?? ''));
  const sizes = (sizeOption?.choices ?? [])
    .map((c) => tidyName(c.value ?? ''))
    .filter(Boolean);

  if (sizes.length === 0) {
    return [{
      productId: p.id,
      productName,
      size: 'One size',
      variantId: null,
      price: basePrice,
    }];
  }

  return sizes.map((size) => {
    const match = (p.variants ?? []).find((v) =>
      Object.values(v.choices ?? {}).some((c) => tidyName(c).toLowerCase() === size.toLowerCase())
    );
    return {
      productId: p.id,
      productName,
      size,
      variantId: match?.id ?? null,
      price: match?.variant?.priceData?.price ?? basePrice,
    };
  });
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: 'Not authorised' }, { status: 401 });
  }

  if (!process.env.WIX_API_KEY || !process.env.WIX_SITE_ID) {
    return NextResponse.json({ error: 'Wix is not connected yet.' }, { status: 400 });
  }

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';

  const res = await fetch('https://www.wixapis.com/stores/v1/products/query', {
    method: 'POST',
    headers: {
      Authorization: process.env.WIX_API_KEY,
      'wix-site-id': process.env.WIX_SITE_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: { paging: { limit: 100 } }, includeVariants: true }),
  });

  if (!res.ok) {
    const detail = await res.text();
    return NextResponse.json(
      { error: `Wix returned ${res.status}`, detail: detail.slice(0, 400) },
      { status: 502 }
    );
  }

  const data = await res.json();
  const products: WixProduct[] = data.products ?? [];

  const supabase = createAdminSupabase();
  const { data: stock } = await supabase
    .from('stock_items')
    .select('id, name, size, price, quantity, wix_product_id, wix_variant_id');

  const rows = (stock ?? []) as StockRow[];
  const byKey = new Map<string, StockRow>();
  for (const r of rows) byKey.set(nameSizeKey(r.name, r.size), r);

  const toLink: Array<Record<string, unknown>> = [];
  const toCreate: Array<Record<string, unknown>> = [];
  const unchanged: string[] = [];
  const skippedAsFees: string[] = [];
  const failed: string[] = [];

  // Two Wix sizes can normalise onto the same tracker row (e.g. "Large"
  // and "L" both present as options). Whichever is seen first wins, and
  // the second is reported rather than silently overwriting it.
  const claimed = new Map<string, string>();
  const duplicateWixSizes: string[] = [];

  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; patch: Record<string, unknown>; label: string }> = [];

  for (const p of products) {
    const productName = tidyName(p.name ?? '');
    if (!productName) continue;
    if (looksLikeAFee(productName)) {
      skippedAsFees.push(productName);
      continue;
    }

    for (const entry of catalogueEntries(p)) {
      const key = nameSizeKey(entry.productName, entry.size);

      const owner = claimed.get(key);
      if (owner) {
        duplicateWixSizes.push(`${entry.productName} / ${entry.size} (already matched by "${owner}")`);
        continue;
      }
      claimed.set(key, entry.size);

      const existing = byKey.get(key);

      if (!existing) {
        toCreate.push({
          name: entry.productName,
          size: entry.size,
          price: entry.price,
          on_hand: 0,
          wix_product_id: entry.productId,
          wix_variant_id: entry.variantId,
        });
        inserts.push({
          name: entry.productName,
          category: guessCategory(entry.productName),
          size: entry.size,
          price: entry.price,
          quantity: 0,
          low_stock_alert: 3,
          wix_product_id: entry.productId,
          wix_variant_id: entry.variantId,
        });
        continue;
      }

      // Only ever these three columns, never quantity.
      const patch: Record<string, unknown> = {};
      if (existing.wix_product_id !== entry.productId) patch.wix_product_id = entry.productId;
      if (existing.wix_variant_id !== entry.variantId) patch.wix_variant_id = entry.variantId;
      if (Number(existing.price) !== Number(entry.price)) patch.price = entry.price;

      if (Object.keys(patch).length === 0) {
        unchanged.push(`${existing.name} / ${existing.size}`);
        continue;
      }

      toLink.push({
        name: existing.name,
        size: existing.size,
        on_hand: existing.quantity,
        ...(patch.wix_product_id !== undefined
          ? { wix_product_id: `${existing.wix_product_id ?? '(none)'} -> ${entry.productId}` }
          : {}),
        ...(patch.wix_variant_id !== undefined
          ? { wix_variant_id: `${existing.wix_variant_id ?? '(none)'} -> ${entry.variantId ?? '(none)'}` }
          : {}),
        ...(patch.price !== undefined
          ? { price: `${Number(existing.price)} -> ${Number(entry.price)}` }
          : {}),
      });

      patch.updated_at = new Date().toISOString();
      updates.push({ id: existing.id, patch, label: `${existing.name} / ${existing.size}` });
    }
  }

  if (!dryRun) {
    if (inserts.length > 0) {
      const { error } = await supabase.from('stock_items').insert(inserts);
      if (error) failed.push(`create: ${error.message}`);
    }
    for (const u of updates) {
      const { error } = await supabase.from('stock_items').update(u.patch).eq('id', u.id);
      if (error) failed.push(`${u.label}: ${error.message}`);
    }
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    note: dryRun
      ? 'Nothing was written. Re-run without ?dryRun=1 to apply exactly this.'
      : 'Applied. Quantities on existing lines were not touched.',
    productsFound: products.length,
    summary: {
      toLink: toLink.length,
      toCreate: toCreate.length,
      unchanged: unchanged.length,
      skippedAsFees: skippedAsFees.length,
      duplicateWixSizes: duplicateWixSizes.length,
      failed: failed.length,
    },
    toLink,
    toCreate,
    unchanged,
    skippedAsFees: Array.from(new Set(skippedAsFees)),
    duplicateWixSizes,
    failed,
  });
}
