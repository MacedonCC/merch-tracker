import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase-server';
import { fetchProductsV3, WixV3Error, type RawProduct } from '@/lib/wix-catalogue-v3';

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

// CATALOGUE V3. The V1 product read this used now answers 501 (Wix moved
// the store to Catalog V3 on or after 6 Oct 2026). The read goes through
// lib/wix-catalogue-v3.ts. Like wix-import it is dry-run only until a V3
// run has been looked at: image and URL fields were written from the V3
// docs, before any real response had been seen, and a wrong guess would
// overwrite every product's image_url with null. ?dryRun=1 reports what
// would change and writes nothing.
const V3_WRITES_ENABLED = false;

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

// V3 puts the primary image at media.main (read-only, the first of
// media.itemsInfo.items). Which of image.url / url / thumbnail.url Wix
// fills is not documented precisely, so each is tried in turn.
function imageOf(p: RawProduct): string | null {
  const m = p.media?.main;
  const first = p.media?.itemsInfo?.items?.[0];
  return (
    m?.image?.url ?? m?.url ?? m?.thumbnail?.url ??
    first?.image?.url ?? first?.url ??
    p.thumbnail?.url ??
    null
  );
}

// V3 returns the page address ready-made, under the URL field.
function productUrlOf(p: RawProduct): string | null {
  const u = p.url?.url;
  return typeof u === 'string' && u ? u : null;
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: 'Not authorised' }, { status: 401 });
  }

  if (!process.env.WIX_API_KEY || !process.env.WIX_SITE_ID) {
    return NextResponse.json({ error: 'Wix is not connected yet.' }, { status: 400 });
  }

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';
  if (!dryRun && !V3_WRITES_ENABLED) {
    return NextResponse.json(
      { error: 'wix-media is switched off for writes while it moves to Catalog V3. Run with ?dryRun=1.' },
      { status: 409 }
    );
  }

  let products: RawProduct[];
  try {
    products = await fetchProductsV3();
  } catch (e) {
    if (e instanceof WixV3Error) {
      return NextResponse.json(
        { error: `Wix returned ${e.status}`, detail: e.detail },
        { status: 502 }
      );
    }
    throw e;
  }

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

  const byProductId = new Map<string, RawProduct>();
  for (const p of products) byProductId.set(p.id, p);

  const updated: string[] = [];
  const noImage: string[] = [];
  const notLinked: string[] = [];
  const failed: string[] = [];
  const wouldChange: string[] = [];

  for (const row of rows) {
    const product = row.wix_product_id ? byProductId.get(row.wix_product_id) : undefined;

    if (!product) {
      notLinked.push(`${row.name} / ${row.size}`);
      continue;
    }

    const image = imageOf(product);
    const url = productUrlOf(product);

    if (!image) noImage.push(String(product.name ?? row.name));

    // Nothing to do if Wix told us nothing new — keeps re-runs cheap and
    // avoids touching every row every time.
    if (image === row.image_url && url === row.wix_product_url) continue;

    if (dryRun) {
      wouldChange.push(`${row.name} / ${row.size}`);
      continue;
    }

    const { error } = await supabase
      .from('stock_items')
      .update({ image_url: image, wix_product_url: url })
      .eq('id', row.id);

    if (error) failed.push(`${row.name} / ${row.size}: ${error.message}`);
    else updated.push(`${row.name} / ${row.size}`);
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    ...(dryRun ? { nothingWasWritten: true, wouldChange: wouldChange.length, wouldChangeRows: wouldChange } : {}),
    productsFound: products.length,
    ...(dryRun ? { sample: products.slice(0, 3).map((p) => ({ name: p.name, image: imageOf(p), url: productUrlOf(p) })) } : {}),
    stockRowsUpdated: updated.length,
    updated,
    productsWithNoImageInWix: Array.from(new Set(noImage)),
    stockRowsNotLinkedToWix: Array.from(new Set(notLinked)),
    failed,
  });
}
