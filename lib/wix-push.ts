import { createAdminSupabase } from '@/lib/supabase-server';
import { fetchInventoryV3, WixV3Error } from '@/lib/wix-catalogue-v3';

// Pushes the tracker's `available` figure into Wix inventory, so a size
// that is spoken for cannot be bought again online.
//
// WHAT GETS SENT is `available` (on_hand - committed), not `on_hand`.
// A garment sitting in the cupboard against an unfulfilled order is not
// for sale, and sending on_hand would offer it to a second buyer.
// Negative available (oversold) clamps to 0: Wix has no concept of
// owing stock, and 0 is the honest answer to "can someone buy this".
//
// WRITES ARE ABSOLUTE, not increments. The tracker is the source of
// truth, so setting a value is idempotent - a repeated or retried push
// cannot drift the count - whereas a repeated decrement would.
//
// ORDERING MATTERS. Between a Wix sale and wix-sync importing it, our
// `committed` is stale-low and therefore `available` is stale-high.
// Pushing in that window would RAISE Wix's count and re-offer something
// just sold. That is why the daily push runs at the END of wix-sync
// rather than on its own schedule: by then the day's orders are in.
//
// CATALOG V3. Wix moved the store to Catalog V3 (6 Oct 2026), so this
// now reads `POST /stores/v3/inventory-items/query` and writes
// `POST /stores/v3/bulk/inventory-items/update`. V3 keeps one inventory
// item per variant per location, and an update must carry the item's
// current `revision` or Wix rejects it - so every push reads first and
// writes the revision it just read. Only a SINGLE location is
// supported: with more than one the push refuses rather than guess which
// one the shop sells from.
//
// THE V3 WRITE PATH HAS NEVER RUN. It was written from the docs and is
// held off by V3_PUSH_WRITES_VERIFIED below, on top of WIX_PUSH_ENABLED.
// Report mode (the preview) is the part that has been exercised; flip
// the constant only after reading a preview and deciding to try a real
// push on purpose.
//
// Nothing here writes to Wix unless the env flag is on, the V3 write
// path has been marked verified, and the caller asked for a real run.
// Report mode does every read, builds every payload, and returns
// exactly what would be sent.

const V3_PUSH_WRITES_VERIFIED = false;

const WIX_API = 'https://www.wixapis.com';

/** A quantity that moves by more than this gets flagged in the report.
 *  The shop's stock moves by single units a day, so a bigger jump is
 *  more likely a wrong link or a stale figure than a real change. */
const BIG_MOVE = 3;

export interface PushLine {
  stockItemId: string;
  name: string;
  size: string;
  onHand: number;
  committed: number;
  available: number;
  /** What Wix will be set to: available clamped at zero. */
  setTo: number;
  wixProductId: string;
  wixVariantId: string | null;
  previousQuantity: number | null;
  previousTracked: boolean | null;
  /** setTo minus what Wix holds now; null when Wix holds no figure. */
  change: number | null;
  /** Why this line deserves a second look; empty when unremarkable. */
  flags: string[];
}

export interface PushResult {
  ok: boolean;
  wrote: boolean;
  reason: string;
  counts: {
    linesConsidered: number;
    wouldBlock: number;
    wouldStayOnSale: number;
    /** Lines whose Wix value would actually move, or that are not yet
     *  tracked. Zero means the shop already agrees with the tracker. */
    wouldChange: number;
    newlyTracked: number;
    productsTouched: number;
    skipped: number;
    /** Lines carrying at least one flag. */
    flagged: number;
    failed: number;
  };
  /** Everything unexpected, in one place, one sentence each. */
  warnings: string[];
  lines: PushLine[];
  skipped: string[];
  failures: string[];
}

interface OverviewRow {
  id: string;
  name: string;
  size: string;
  on_hand: number;
  committed: number;
  available: number;
}

interface ItemRow {
  id: string;
  wix_product_id: string | null;
  wix_variant_id: string | null;
  retired_at: string | null;
}

interface InvItem {
  id: string;
  revision: string;
  productId: string;
  variantId: string;
  locationId?: string;
  quantity: number | null;
  trackQuantity: boolean | null;
}

export function pushEnabled(): boolean {
  return process.env.WIX_PUSH_ENABLED === 'true';
}

async function wixPost(path: string, body: unknown) {
  const res = await fetch(`${WIX_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: process.env.WIX_API_KEY as string,
      'wix-site-id': process.env.WIX_SITE_ID as string,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 400); }
  return { ok: res.ok, status: res.status, body: parsed };
}

const EMPTY_COUNTS = {
  linesConsidered: 0, wouldBlock: 0, wouldStayOnSale: 0, wouldChange: 0,
  newlyTracked: 0, productsTouched: 0, skipped: 0, flagged: 0, failed: 0,
};

export async function pushAvailableToWix(opts: {
  /** false = report only, write nothing, whatever the env flag says. */
  write: boolean;
  source: 'cron' | 'manual';
  pushedBy?: string | null;
}): Promise<PushResult> {
  const skipped: string[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];

  if (!process.env.WIX_API_KEY || !process.env.WIX_SITE_ID) {
    return {
      ok: false, wrote: false, reason: 'Wix is not connected.',
      counts: { ...EMPTY_COUNTS }, warnings, lines: [], skipped, failures,
    };
  }

  const supabase = createAdminSupabase();
  const [{ data: overview }, { data: items }] = await Promise.all([
    supabase.from('stock_overview').select('id, name, size, on_hand, committed, available'),
    supabase.from('stock_items').select('id, wix_product_id, wix_variant_id, retired_at'),
  ]);

  const linkById = new Map(((items ?? []) as ItemRow[]).map((r) => [r.id, r]));

  // Current Wix inventory, so the log can record what each value was
  // before, report mode can show the actual change, and a write can
  // carry each item's current revision.
  let raw;
  try {
    raw = await fetchInventoryV3();
  } catch (e) {
    const status = e instanceof WixV3Error ? e.status : 0;
    return {
      ok: false, wrote: false,
      reason: `Could not read Wix inventory (HTTP ${status || 'error'}).`,
      counts: { ...EMPTY_COUNTS, failed: 1 }, warnings, lines: [], skipped,
      failures: [e instanceof WixV3Error ? e.detail : 'Inventory read failed.'],
    };
  }

  const locationIds = new Set<string>();
  for (const i of raw) if (i.locationId) locationIds.add(i.locationId);
  if (locationIds.size > 1) {
    return {
      ok: false, wrote: false,
      reason: `Wix has ${locationIds.size} inventory locations. The push only supports one, so it will not guess which the shop sells from.`,
      counts: { ...EMPTY_COUNTS }, warnings, lines: [], skipped, failures,
    };
  }

  const invByVariant = new Map<string, InvItem>();
  const invByProduct = new Map<string, InvItem[]>();
  for (const i of raw) {
    if (!i.id || !i.productId || !i.variantId) continue;
    const item: InvItem = {
      id: i.id,
      revision: String(i.revision ?? ''),
      productId: i.productId,
      variantId: i.variantId,
      locationId: i.locationId,
      quantity: typeof i.quantity === 'number' ? i.quantity : null,
      trackQuantity: typeof i.trackQuantity === 'boolean' ? i.trackQuantity : null,
    };
    invByVariant.set(`${item.productId}::${item.variantId}`, item);
    const list = invByProduct.get(item.productId) ?? [];
    list.push(item);
    invByProduct.set(item.productId, list);
  }

  const lines: PushLine[] = [];
  /** The inventory item each line writes to, parallel to `lines`. */
  const target = new Map<string, InvItem>();

  for (const row of ((overview ?? []) as OverviewRow[])) {
    const link = linkById.get(row.id);
    if (!link?.wix_product_id) continue; // not in the shop; nothing to push
    // A retired line is not a push failure, so it is dropped before
    // the reporting below rather than landing in `skipped`. Retirement
    // clears wix_variant_id, which would otherwise make every retired
    // size of a sized product report as "has no variant id" on every
    // run - a standing complaint about something already decided.
    if (link.retired_at) continue;

    const label = `${row.name} / ${row.size}`;
    const productItems = invByProduct.get(link.wix_product_id) ?? [];
    if (productItems.length === 0) {
      skipped.push(`${label}: no Wix inventory item for its product`);
      warnings.push(`${label}: Wix has no inventory record for this product, so it cannot be set.`);
      continue;
    }

    // A sized line names its variant. An unsized line carries none, and
    // is only unambiguous when the product has exactly one variant.
    let inv: InvItem | undefined;
    if (link.wix_variant_id) {
      inv = invByVariant.get(`${link.wix_product_id}::${link.wix_variant_id}`);
    } else if (productItems.length === 1) {
      inv = productItems[0];
    } else {
      skipped.push(`${label}: product has variants but this line has no variant id`);
      continue;
    }
    if (!inv) {
      skipped.push(`${label}: no Wix inventory record for this size`);
      warnings.push(`${label}: no Wix inventory record for this size, so it cannot be set.`);
      continue;
    }

    const setTo = Math.max(0, row.available);
    const flags: string[] = [];
    if (inv.trackQuantity !== true) {
      flags.push('Wix is not counting this size by quantity; a push would switch it to counted');
    }
    if (inv.quantity === null) {
      flags.push('Wix holds no quantity for this size');
    } else if (Math.abs(setTo - inv.quantity) > BIG_MOVE) {
      flags.push(`moves by ${setTo - inv.quantity > 0 ? '+' : ''}${setTo - inv.quantity} (Wix ${inv.quantity} -> ${setTo})`);
    }
    if (inv.quantity !== null && inv.quantity < 0 && setTo !== inv.quantity) {
      flags.push('Wix currently holds a negative count');
    }

    const line: PushLine = {
      stockItemId: row.id,
      name: row.name,
      size: row.size,
      onHand: row.on_hand,
      committed: row.committed,
      available: row.available,
      setTo,
      wixProductId: link.wix_product_id,
      wixVariantId: link.wix_variant_id,
      previousQuantity: inv.quantity,
      previousTracked: inv.trackQuantity,
      change: inv.quantity === null ? null : setTo - inv.quantity,
      flags,
    };
    lines.push(line);
    target.set(row.id, inv);
    for (const f of flags) warnings.push(`${label}: ${f}.`);
  }

  const productIds = new Set(lines.map((l) => l.wixProductId));

  const counts = {
    linesConsidered: lines.length,
    wouldBlock: lines.filter((l) => l.setTo === 0).length,
    wouldStayOnSale: lines.filter((l) => l.setTo > 0).length,
    wouldChange: lines.filter((l) => l.previousQuantity !== l.setTo || l.previousTracked !== true).length,
    newlyTracked: lines.filter((l) => l.previousTracked !== true).length,
    productsTouched: productIds.size,
    skipped: skipped.length,
    flagged: lines.filter((l) => l.flags.length > 0).length,
    failed: 0,
  };

  const reallyWrite = opts.write && pushEnabled() && V3_PUSH_WRITES_VERIFIED;
  if (!reallyWrite) {
    return {
      ok: true,
      wrote: false,
      reason: !opts.write
        ? 'Report only — nothing was sent to Wix.'
        : !pushEnabled()
          ? 'WIX_PUSH_ENABLED is not "true", so nothing was sent to Wix.'
          : 'The Catalog V3 write path has not been verified yet, so nothing was sent to Wix.',
      counts, warnings, lines, skipped, failures,
    };
  }

  // One bulk call sets every line at its absolute value, carrying the
  // revision read above. Setting `quantity` is also what makes Wix count
  // the item, so there is no separate tracking switch to turn on. A
  // revision that moved since the read (someone edited the item, or a
  // sale landed) fails that one item, not the whole push, and shows up
  // below as a failure to retry.
  const ordered = lines.map((l) => ({ line: l, inv: target.get(l.stockItemId) as InvItem }));
  const okByLine = new Map<string, string | null>(); // null = ok, string = error
  for (let start = 0; start < ordered.length; start += 1000) {
    const chunk = ordered.slice(start, start + 1000);
    const res = await wixPost('/stores/v3/bulk/inventory-items/update', {
      inventoryItems: chunk.map(({ line, inv }) => ({
        inventoryItem: { id: inv.id, revision: inv.revision, quantity: line.setTo },
      })),
      reason: 'MANUAL',
      returnEntity: false,
    });

    if (!res.ok) {
      for (const { line } of chunk) okByLine.set(line.stockItemId, `HTTP ${res.status}`);
      failures.push(`bulk update: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
      continue;
    }
    const results = ((res.body as { results?: Array<{ itemMetadata?: { originalIndex?: number; success?: boolean; error?: { description?: string } } }> }).results) ?? [];
    chunk.forEach(({ line }, idx) => {
      const r = results.find((x) => (x.itemMetadata?.originalIndex ?? -1) === idx) ?? results[idx];
      if (r?.itemMetadata?.success) {
        okByLine.set(line.stockItemId, null);
      } else {
        const why = r?.itemMetadata?.error?.description ?? 'no result returned';
        okByLine.set(line.stockItemId, why);
        failures.push(`${line.name} / ${line.size}: ${why}`);
      }
    });
  }

  const logRows: Array<Record<string, unknown>> = lines.map((l) => {
    const err = okByLine.get(l.stockItemId) ?? 'not sent';
    return {
      stock_item_id: l.stockItemId,
      wix_product_id: l.wixProductId,
      wix_variant_id: l.wixVariantId,
      quantity: l.setTo,
      previous_quantity: l.previousQuantity,
      ok: err === null,
      error: err === null ? null : err.slice(0, 200),
      source: opts.source,
      pushed_by: opts.pushedBy ?? null,
    };
  });
  counts.failed = logRows.filter((r) => !r.ok).length;

  // Logged even when the push failed, and even when every value already
  // matched: "did pressing the button do anything?" has to be
  // answerable from the data, not inferred from silence.
  if (logRows.length > 0) {
    const { error } = await supabase.from('wix_stock_pushes').insert(logRows);
    if (error) failures.push(`push log: ${error.message}`);
  } else {
    const { error } = await supabase.from('wix_stock_pushes').insert({
      stock_item_id: null,
      quantity: 0,
      ok: true,
      error: 'No linked sizes to push.',
      source: opts.source,
      pushed_by: opts.pushedBy ?? null,
    });
    if (error) failures.push(`push log: ${error.message}`);
  }

  return {
    ok: counts.failed === 0,
    wrote: true,
    reason: counts.failed > 0
      ? `Pushed ${lines.length} sizes; ${counts.failed} failed.`
      : counts.wouldChange === 0
        ? `Nothing to change — all ${lines.length} sizes already matched Wix.`
        : `Pushed ${lines.length} sizes across ${productIds.size} products; ${counts.wouldChange} changed.`,
    counts, warnings, lines, skipped, failures,
  };
}
