import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase-server';

// Pulls the product list out of the Wix store and creates matching stock items.
// Run this once at setup, and again whenever new products are added in Wix.
//
// Quantities are set to 0 — Wix knows what you sell, not what is in the
// cupboard. Set the real counts in the tracker afterwards.

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

export async function GET(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: 'Not authorised' }, { status: 401 });
  }

  if (!process.env.WIX_API_KEY || !process.env.WIX_SITE_ID) {
    return NextResponse.json({ error: 'Wix is not connected yet.' }, { status: 400 });
  }

  const res = await fetch('https://www.wixapis.com/stores/v1/products/query', {
    method: 'POST',
    headers: {
      Authorization: process.env.WIX_API_KEY,
      'wix-site-id': process.env.WIX_SITE_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: { paging: { limit: 100 } },
      includeVariants: true,
    }),
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

  const created: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const p of products) {
    const name = (p.name ?? '').trim();
    if (!name) continue;

    if (looksLikeAFee(name)) {
      skipped.push(name);
      continue;
    }

    const category = guessCategory(name);
    const basePrice = p.priceData?.price ?? 0;

    // Find a size option if the product has one.
    const sizeOption = (p.productOptions ?? []).find((o) =>
      /size/i.test(o.name ?? '')
    );
    const sizes = (sizeOption?.choices ?? [])
      .map((c) => (c.value ?? '').trim())
      .filter(Boolean);

    const rows =
      sizes.length > 0
        ? sizes.map((size) => {
            const match = (p.variants ?? []).find((v) =>
              Object.values(v.choices ?? {}).some(
                (c) => c.toLowerCase() === size.toLowerCase()
              )
            );
            return {
              name,
              category,
              size,
              price: match?.variant?.priceData?.price ?? basePrice,
              quantity: 0,
              low_stock_alert: 3,
              wix_product_id: p.id,
              wix_variant_id: match?.id ?? null,
            };
          })
        : [
            {
              name,
              category,
              size: 'One size',
              price: basePrice,
              quantity: 0,
              low_stock_alert: 3,
              wix_product_id: p.id,
              wix_variant_id: null,
            },
          ];

    for (const row of rows) {
      const { error } = await supabase
        .from('stock_items')
        .upsert(row, { onConflict: 'name,size' });

      if (error) failed.push(`${row.name} / ${row.size}: ${error.message}`);
      else created.push(`${row.name} / ${row.size}`);
    }
  }

  return NextResponse.json({
    ok: true,
    productsFound: products.length,
    stockLinesCreated: created.length,
    created,
    skippedAsFees: skipped,
    failed,
    note: 'Quantities are set to 0. Set your real counts in the tracker.',
  });
}
