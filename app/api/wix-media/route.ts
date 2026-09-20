import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase-server';

// Populates stock_items.image_url and stock_items.wix_product_url from
// the Wix product catalogue, keyed on wix_product_id. The /sell flow
// uses the image for its product grid and the URL for the "send payment
// link" path, so a parent lands on the exact product rather than the
// shop front.
//
// Run it after wix-import, and again whenever product photos change in
// Wix. Safe to re-run: it only writes rows whose values actually differ.
//
// Every size of a product shares one wix_product_id, so all of that
// product's stock_items rows get the same image and URL. Items that were
// never linked to Wix are left null, and the UI falls back to a text
// tile with no payment link rather than showing a broken image.

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface WixImage {
  url?: string;
}

interface WixMediaItem {
  image?: WixImage;
}

interface WixProduct {
  id: string;
  name?: string;
  // Wix has moved this shape around between API versions, so both known
  // spellings are checked rather than trusting one. mainMedia is the
  // product's primary image; media.items[0] is the fallback for
  // catalogues where mainMedia is not populated.
  media?: { mainMedia?: WixMediaItem; items?: WixMediaItem[] };
  productPageUrl?: { base?: string; path?: string };
}

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

function imageOf(p: WixProduct): string | null {
  return (
    p.media?.mainMedia?.image?.url ??
    p.media?.items?.find((i) => i.image?.url)?.image?.url ??
    null
  );
}

// productPageUrl comes back split into base + path. Joining them with a
// single slash regardless of which side carries one keeps this working
// whether or not Wix includes it.
function productUrlOf(p: WixProduct): string | null {
  const base = p.productPageUrl?.base?.replace(/\/+$/, '');
  const path = p.productPageUrl?.path?.replace(/^\/+/, '');
  if (!base || !path) return null;
  return `${base}/${path}`;
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
    body: JSON.stringify({ query: { paging: { limit: 100 } } }),
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
    .select('id, name, size, wix_product_id, image_url, wix_product_url');

  type Row = {
    id: string; name: string; size: string;
    wix_product_id: string | null;
    image_url: string | null;
    wix_product_url: string | null;
  };
  const rows = (stock ?? []) as Row[];

  const byProductId = new Map<string, WixProduct>();
  for (const p of products) byProductId.set(p.id, p);

  const updated: string[] = [];
  const noImage: string[] = [];
  const notLinked: string[] = [];
  const failed: string[] = [];

  for (const row of rows) {
    const product = row.wix_product_id ? byProductId.get(row.wix_product_id) : undefined;

    if (!product) {
      notLinked.push(`${row.name} / ${row.size}`);
      continue;
    }

    const image = imageOf(product);
    const url = productUrlOf(product);

    if (!image) noImage.push(product.name ?? row.name);

    // Nothing to do if Wix told us nothing new — keeps re-runs cheap and
    // avoids touching every row every time.
    if (image === row.image_url && url === row.wix_product_url) continue;

    const { error } = await supabase
      .from('stock_items')
      .update({ image_url: image, wix_product_url: url })
      .eq('id', row.id);

    if (error) failed.push(`${row.name} / ${row.size}: ${error.message}`);
    else updated.push(`${row.name} / ${row.size}`);
  }

  return NextResponse.json({
    ok: true,
    productsFound: products.length,
    stockRowsUpdated: updated.length,
    updated,
    productsWithNoImageInWix: Array.from(new Set(noImage)),
    stockRowsNotLinkedToWix: Array.from(new Set(notLinked)),
    failed,
  });
}
