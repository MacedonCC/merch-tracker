import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase-server';
import { nameSizeKey, tidyName } from '@/lib/types';
import { loadCatalogueV3, WixV3Error, type CatProduct, type RawInventoryItem } from '@/lib/wix-catalogue-v3';

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
//
// WIX QUANTITIES are reported but never acted on. `wixStock` lists
// every catalogue size with what Wix believes it holds, next to the
// tracker's own on_hand, and it covers products the tracker has no
// line for yet — which is the whole point: a brand new Wix product
// cannot be looked up any other way until a line exists for it. This
// is a report, not a stock feed. Nothing reads it back, and the
// database would refuse a quantity write from this route anyway
// (migration 20260920000007). If a Wix count is ever to become the
// tracker's count, that is a deliberate human act with a
// stock_movements row behind it, not a side effect of an import.

// CATALOGUE V3. Wix moved the store to Catalog V3 (6 Oct 2026); the V1
// product read and V2 inventory read this route used answer 501. The
// read side now goes through lib/wix-catalogue-v3.ts. The write side
// below is switched off (V3_WRITES_ENABLED) until a V3 dry run has been
// read and approved, because whether Wix kept the old variant ids is not
// documented - staleVariantIds in the dry run is the test. Do not turn
// it on before that has been looked at.
const V3_WRITES_ENABLED = false;

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface StockRow {
  id: string;
  name: string;
  size: string;
  price: number | string;
  quantity: number;
  wix_product_id: string | null;
  wix_variant_id: string | null;
  wix_listed_at: string | null;
}

/** One Wix catalogue entry: a product/size pair and what it costs. */
interface CatalogueEntry {
  productId: string;
  productName: string;
  size: string;
  /** The id reported to the tracker: null for an unsized product, as it
   *  has always been. */
  variantId: string | null;
  /** The real V3 variant id, used only to look up Wix's inventory. An
   *  unsized V3 product still has exactly one (default) variant. */
  inventoryVariantId: string | null;
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

// Order matters: the narrower words have to be tested before the
// broader ones. "Club Beanie" contains no "cap", but "Broad Rim Playing
// Hat" and "MCC Senior Baggy Cap" both need to land somewhere specific,
// and a single hat/cap rule used to put the broad-rim in with the caps.
// Keep in step with CATEGORIES in components/TrackerSection.tsx.
//
// SHORTS IS MATCHED ON THE PLURAL, as a whole word. A substring test
// for "short" swallowed "Juniors Coloured Playing Shirts Short Sleeve
// (Unisex)" and filed five junior shirt lines under Shorts - the
// garment is named for its sleeves, not its legs. Ordering 'shirt'
// above 'short' would fix that one name and break the next product
// that genuinely mentions both. \bshorts\b does not match "Short
// Sleeve" and still matches "Training Shorts", which is the actual
// distinction: the plural noun names the garment, the adjective
// describes part of another one.
function guessCategory(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('beanie')) return 'Beanie';
  if (n.includes('hoodie') || n.includes('hoody')) return 'Hoodie';
  if (n.includes('jacket') || n.includes('vest')) return 'Jacket';
  if (/\bshorts\b/.test(n)) return 'Shorts';
  if (n.includes('pant')) return 'Pants';
  if (n.includes('cap') || n.includes('baggy')) return 'Cap';
  if (n.includes('hat')) return 'Hat';
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
// Sizes come from the variants' own option choices (V3 product queries
// return no variants, so there is no product-level option list to read).
function catalogueEntries(p: CatProduct): CatalogueEntry[] {
  const productName = tidyName(p.name);

  const sized: Array<{ size: string; id: string; price: number | null }> = [];
  for (const v of p.variants) {
    const choice = v.choices.find((c) => /size/i.test(c.option))?.choice;
    const size = choice ? tidyName(choice) : '';
    if (size) sized.push({ size, id: v.id, price: v.price });
  }

  if (sized.length === 0) {
    const only = p.variants[0];
    return [{
      productId: p.id,
      productName,
      size: 'One size',
      variantId: null,
      inventoryVariantId: only?.id ?? null,
      price: only?.price ?? 0,
    }];
  }

  // First variant wins when a size repeats (e.g. size x colour), as the
  // V1 lookup did.
  const seen = new Set<string>();
  const entries: CatalogueEntry[] = [];
  for (const x of sized) {
    const k = x.size.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    entries.push({
      productId: p.id,
      productName,
      size: x.size,
      variantId: x.id,
      inventoryVariantId: x.id,
      price: x.price ?? 0,
    });
  }
  return entries;
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

  let catalogue;
  try {
    catalogue = await loadCatalogueV3();
  } catch (e) {
    if (e instanceof WixV3Error) {
      return json({ error: `Wix returned ${e.status}`, where: e.where, detail: e.detail }, 502);
    }
    throw e;
  }
  const { products } = catalogue;

  if (raw) {
    // ?raw=1 shows what Wix actually sent for ONE product, so the V3
    // shape can be read rather than assumed. ?product= takes an id or
    // part of a name; with none, the first product is used.
    const want = (req.nextUrl.searchParams.get('product') ?? '').toLowerCase();
    const idx = want
      ? catalogue.rawProducts.findIndex(
          (p) => String(p.id).toLowerCase() === want || String(p.name ?? '').toLowerCase().includes(want)
        )
      : 0;
    const rawProduct = idx >= 0 ? catalogue.rawProducts[idx] : null;
    const pid: string | undefined = rawProduct?.id;
    return json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      counts: {
        products: catalogue.rawProducts.length,
        variants: catalogue.rawVariants.length,
        inventoryItems: catalogue.rawInventory.length,
      },
      ...(catalogue.inventoryError ? { inventoryError: catalogue.inventoryError } : {}),
      productNames: catalogue.rawProducts.map((p) => p.name),
      shownProduct: rawProduct ? { id: pid, name: rawProduct.name } : `no product matched "${want}"`,
      rawProduct,
      rawVariants: catalogue.rawVariants.filter((v) => v.productData?.productId === pid),
      rawInventoryItems: catalogue.rawInventory.filter((i) => i.productId === pid),
    });
  }

  if (!dryRun && !V3_WRITES_ENABLED) {
    return json(
      {
        error:
          'The real import is switched off while it moves to Catalog V3. Run with ?dryRun=1, review it, and it will be switched back on deliberately.',
      },
      409
    );
  }

  // Wix stock, from V3 inventory items (one per variant per location).
  // A failure here must not fail the import: linking and prices are the
  // job, quantities are commentary, so the report says the read failed
  // and carries on with nulls.
  const wixStockError: string | null = catalogue.inventoryError;
  const invByVariant = new Map<string, { quantity: number | null; tracked: boolean | null }>();
  const locationIds = new Set<string>();
  for (const i of catalogue.rawInventory as RawInventoryItem[]) {
    if (!i.productId || !i.variantId) continue;
    if (i.locationId) locationIds.add(i.locationId);
    const key = `${i.productId}::${i.variantId}`;
    const q = typeof i.quantity === 'number' ? i.quantity : null;
    const prev = invByVariant.get(key);
    // More than one location sums, so the figure is the whole shop's;
    // wixLocations is reported so that is visible, not assumed.
    invByVariant.set(key, {
      quantity: q === null ? (prev?.quantity ?? null) : (prev?.quantity ?? 0) + q,
      tracked: typeof i.trackQuantity === 'boolean' ? i.trackQuantity : (prev?.tracked ?? null),
    });
  }

  function wixStockFor(productId: string, variantId: string | null) {
    const item = variantId ? invByVariant.get(`${productId}::${variantId}`) : undefined;
    // No inventory item reads as null, not 0: "Wix did not tell us" and
    // "Wix says none left" are different answers and only one of them
    // is a count.
    return { wixQuantity: item?.quantity ?? null, wixTracked: item?.tracked ?? null };
  }

  const supabase = createAdminSupabase();
  const { data: stock } = await supabase
    .from('stock_items')
    .select('id, name, size, price, quantity, wix_product_id, wix_variant_id, wix_listed_at');

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
    for (const v of p.variants) liveVariantIds.add(`${p.id}::${v.id}`);
  }
  const staleVariantIds = rows
    .filter((r) => r.wix_variant_id && !liveVariantIds.has(`${r.wix_product_id}::${r.wix_variant_id}`))
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
    for (const p of products) wixNameById.set(p.id, tidyName(p.name));
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

  // Every Wix catalogue size with what Wix thinks it holds, beside the
  // tracker's own figure. Built in its own read-only pass, deliberately
  // NOT through findRow(): that function consumes a row as it matches,
  // and a report must not change what the import then does. It looks
  // rows up directly instead, so a size can appear here with
  // trackerLine null - exactly the case a new Wix product is in, and
  // the reason this exists.
  const wixStock: Array<Record<string, unknown>> = [];
  for (const p of products) {
    const productName = tidyName(p.name);
    if (!productName || looksLikeAFee(productName)) continue;
    for (const e of catalogueEntries(p)) {
      const tracker =
        (e.variantId ? byVariant.get(`${e.productId}::${e.variantId}`) : undefined) ??
        byKey.get(nameSizeKey(e.productName, e.size)) ??
        null;
      wixStock.push({
        product: e.productName,
        size: e.size,
        ...wixStockFor(e.productId, e.inventoryVariantId),
        trackerLine: tracker ? `${tracker.name} / ${tracker.size}` : null,
        trackerOnHand: tracker ? tracker.quantity : null,
        productId: e.productId,
        variantId: e.variantId,
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

  const now = new Date().toISOString();
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; patch: Record<string, unknown>; label: string }> = [];

  for (const p of products) {
    const productName = tidyName(p.name);
    if (!productName) continue;
    if (looksLikeAFee(productName)) {
      skippedAsFees.push(productName);
      continue;
    }

    const entries = catalogueEntries(p);

    if (dryRun && entries.some((e) => e.variantId === null) && wixDiagnostics.length < 4) {
      wixDiagnostics.push({
        product: productName,
        variantsReturned: p.variants.length,
        firstVariant: p.variants[0] ?? null,
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
          // Created at zero whatever Wix says it holds - see the
          // header. The Wix figure rides along so the person reading
          // the report can see what they would be signing up to.
          on_hand: 0,
          ...wixStockFor(entry.productId, entry.inventoryVariantId),
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
          wix_listed_at: now,
        });
        continue;
      }

      // Only ever these columns, never quantity.
      const patch: Record<string, unknown> = {};
      // Stamped the first time a line is linked, and never again -
      // /restock reads it to tell "was on sale and sold none" apart
      // from "was not on sale yet". Re-stamping on a later run would
      // make an old line look new and wipe out its sales history. The
      // database enforces this too (migration 20260920000009), so a
      // future edit here cannot quietly undo it.
      if (!existing.wix_listed_at) patch.wix_listed_at = now;
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
        ...wixStockFor(entry.productId, entry.inventoryVariantId),
        ...(patch.wix_product_id !== undefined
          ? { wix_product_id: `${existing.wix_product_id ?? '(none)'} -> ${entry.productId}` }
          : {}),
        ...(patch.wix_variant_id !== undefined
          ? { wix_variant_id: `${existing.wix_variant_id ?? '(none)'} -> ${entry.variantId ?? '(none)'}` }
          : {}),
        ...(patch.price !== undefined
          ? { price: `${Number(existing.price)} -> ${Number(entry.price)}` }
          : {}),
        ...(patch.wix_listed_at !== undefined ? { firstListedNow: true } : {}),
      });

      patch.updated_at = now;
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
      wixStockLines: wixStock.length,
      wixStockUnlinked: wixStock.filter((w) => w.trackerLine === null).length,
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
    wixStock,
    ...(wixStockError ? { wixStockError } : {}),
    wixLocations: locationIds.size,
    failed,
  });
}
