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
  /** Wix's "Manage pricing and inventory for each product variant"
   *  toggle. When it is off, Wix stores no variant records for the
   *  product, so `variants` comes back empty even with
   *  includeVariants: true and there is no variant id to link to. */
  manageVariants?: boolean;
  /** When Wix last changed this product. If the shop shows an edit that
   *  this timestamp predates, the API is serving a stale catalogue and
   *  the problem is upstream of this route. */
  lastUpdated?: string;
  numericId?: string;
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

// Vercel returned `Cache-Control: public, max-age=0, must-revalidate`
// on this route by default. "public" lets a shared cache store the
// response, and a dry run repeated after several Wix edits came back
// byte-identical (same MD5) while a never-before-requested URL on the
// same route returned X-Vercel-Cache: BYPASS with the edits present.
// Every response here is a point-in-time view of someone else's
// catalogue, so none of it may be stored by anything.
function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'CDN-Cache-Control': 'no-store',
      'Vercel-CDN-Cache-Control': 'no-store',
    },
  });
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
    return json({ error: 'Not authorised' }, 401);
  }

  if (!process.env.WIX_API_KEY || !process.env.WIX_SITE_ID) {
    return json({ error: 'Wix is not connected yet.' }, 400);
  }

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';
  // ?raw=1 returns what Wix actually sent - every product name, when it
  // was last changed, and its size choices - and nothing else. Use it
  // when the catalogue in the API disagrees with the live shop.
  const raw = req.nextUrl.searchParams.get('raw') === '1';

  const res = await fetch('https://www.wixapis.com/stores/v1/products/query', {
    method: 'POST',
    headers: {
      Authorization: process.env.WIX_API_KEY,
      'wix-site-id': process.env.WIX_SITE_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: { paging: { limit: 100 } }, includeVariants: true }),
    // See lib/no-store-fetch.ts for why this matters in this codebase:
    // Next's Data Cache has served stale responses to routes that
    // looked dynamic. This is a POST so it should not be cached, but
    // the cost of being explicit is nil and it removes one suspect when
    // the catalogue looks out of date.
    cache: 'no-store',
  });

  if (!res.ok) {
    const detail = await res.text();
    return json({ error: `Wix returned ${res.status}`, detail: detail.slice(0, 400) }, 502);
  }

  const data = await res.json();
  const products: WixProduct[] = data.products ?? [];

  if (raw) {
    return json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      productsFound: products.length,
      products: products.map((p) => ({
        name: p.name,
        id: p.id,
        lastUpdated: p.lastUpdated ?? '(not returned)',
        manageVariants: p.manageVariants ?? '(not returned)',
        sizeChoices:
          (p.productOptions ?? [])
            .filter((o) => /size/i.test(o.name ?? ''))
            .flatMap((o) => (o.choices ?? []).map((c) => c.value)) ?? [],
        variantsReturned: (p.variants ?? []).length,
        variants: (p.variants ?? []).map((v) => ({
          id: v.id,
          choices: v.choices ?? {},
        })),
      })),
    });
  }

  const supabase = createAdminSupabase();
  const { data: stock } = await supabase
    .from('stock_items')
    .select('id, name, size, price, quantity, wix_product_id, wix_variant_id');

  const rows = (stock ?? []) as StockRow[];

  // MATCH ORDER: variant id, then product id, then name + size.
  //
  // Identity beats spelling. A product renamed in Wix keeps its id, so
  // an id match survives a rename; a name match does not, and would
  // treat every size of the renamed product as new and create a full
  // set of empty duplicates.
  //
  // The product-id map only holds products where exactly ONE tracker
  // row carries that id, mirroring wix-sync: when several sizes share a
  // product id, matching on the id alone would bind whichever row
  // happened to be indexed last.
  const byVariant = new Map<string, StockRow>();
  const byProduct = new Map<string, StockRow>();
  const byKey = new Map<string, StockRow>();
  const productIdCounts = new Map<string, number>();

  for (const r of rows) {
    if (r.wix_product_id) {
      productIdCounts.set(r.wix_product_id, (productIdCounts.get(r.wix_product_id) ?? 0) + 1);
      if (r.wix_variant_id) byVariant.set(`${r.wix_product_id}::${r.wix_variant_id}`, r);
    }
    byKey.set(nameSizeKey(r.name, r.size), r);
  }
  for (const r of rows) {
    if (r.wix_product_id && productIdCounts.get(r.wix_product_id) === 1) {
      byProduct.set(r.wix_product_id, r);
    }
  }

  // Editing a product's size options in Wix REGENERATES its variant
  // ids: the old ones cease to exist. A tracker row still holding a
  // dead id can no longer be matched by id, and silently falls back to
  // name matching - or, if the product was also renamed, to nothing at
  // all, which is how a size ends up duplicated with its stock
  // stranded on the old row. Every stored id is checked against every
  // id Wix returned so this is visible rather than inferred.
  const liveVariantIds = new Set<string>();
  for (const p of products) {
    for (const v of p.variants ?? []) if (v.id) liveVariantIds.add(v.id);
  }
  const staleVariantIds = rows
    .filter((r) => r.wix_variant_id && !liveVariantIds.has(r.wix_variant_id))
    .map((r) => `${r.name} / ${r.size}: ${r.wix_variant_id}`);

  // A linked row whose tracker name no longer matches its Wix product.
  // This is survivable on its own - an id match does not care what
  // anything is called - but it is the first half of the failure that
  // strands stock. The second half is Wix regenerating a variant id
  // (which it does whenever a product's size options are edited); with
  // both, a size matches neither by id nor by name, gets created as a
  // new line, and its stock is left on the old row. Flagged here so a
  // rename is noticed while it is still harmless.
  const nameDrift: Array<Record<string, string>> = [];
  {
    const wixNameById = new Map<string, string>();
    for (const p of products) wixNameById.set(p.id, tidyName(p.name ?? ''));
    const reported = new Set<string>();
    for (const r of rows) {
      if (!r.wix_product_id) continue;
      const wixName = wixNameById.get(r.wix_product_id);
      if (!wixName || wixName === r.name || reported.has(r.name)) continue;
      reported.add(r.name);
      nameDrift.push({
        tracker: r.name,
        wix: wixName,
        matchesAnyway: nameSizeKey(r.name, '') === nameSizeKey(wixName, '')
          ? 'yes - differs only by punctuation'
          : 'NO - name fallback will not match this product',
      });
    }
  }

  // A row already linked to a DIFFERENT Wix product must not be stolen
  // by a name collision, and one row must not be claimed twice.
  const consumed = new Set<string>();
  const conflicts: string[] = [];

  function findRow(entry: CatalogueEntry): StockRow | undefined {
    const viaVariant = entry.variantId
      ? byVariant.get(`${entry.productId}::${entry.variantId}`)
      : undefined;
    const viaProduct =
      productIdCounts.get(entry.productId) === 1 ? byProduct.get(entry.productId) : undefined;
    const viaName = byKey.get(nameSizeKey(entry.productName, entry.size));

    const row = viaVariant ?? viaProduct ?? viaName;
    if (!row) return undefined;

    if (consumed.has(row.id)) {
      conflicts.push(`${entry.productName} / ${entry.size}: row already matched by another Wix entry`);
      return undefined;
    }
    // Only the name fallback can cross products; an id match is by
    // definition the right product.
    if (!viaVariant && !viaProduct && row.wix_product_id && row.wix_product_id !== entry.productId) {
      conflicts.push(
        `${entry.productName} / ${entry.size}: name matches "${row.name} / ${row.size}", which is linked to a different Wix product`
      );
      return undefined;
    }
    consumed.add(row.id);
    return row;
  }

  // Collected in dry-run mode only, to show why a product yielded no
  // variant id rather than leaving it to guesswork.
  const wixDiagnostics: Array<Record<string, unknown>> = [];

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

    const entries = catalogueEntries(p);

    if (dryRun && entries.some((e) => e.variantId === null) && wixDiagnostics.length < 4) {
      wixDiagnostics.push({
        product: productName,
        manageVariants: p.manageVariants ?? '(field absent from response)',
        sizeOptionsFound: (p.productOptions ?? []).map((o) => ({
          option: o.name,
          choices: (o.choices ?? []).map((c) => c.value),
        })),
        variantsReturned: (p.variants ?? []).length,
        firstVariantRaw: (p.variants ?? [])[0] ?? null,
      });
    }

    for (const entry of entries) {
      const key = nameSizeKey(entry.productName, entry.size);

      const owner = claimed.get(key);
      if (owner) {
        duplicateWixSizes.push(`${entry.productName} / ${entry.size} (already matched by "${owner}")`);
        continue;
      }
      claimed.set(key, entry.size);

      const existing = findRow(entry);

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

  return json({
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
      conflicts: conflicts.length,
      staleVariantIds: staleVariantIds.length,
      nameDrift: nameDrift.length,
      failed: failed.length,
    },
    toLink,
    toCreate,
    unchanged,
    skippedAsFees: Array.from(new Set(skippedAsFees)),
    ...(dryRun ? { wixDiagnostics } : {}),
    duplicateWixSizes,
    conflicts,
    staleVariantIds,
    nameDrift,
    failed,
  });
}
