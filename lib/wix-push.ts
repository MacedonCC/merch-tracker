import { createAdminSupabase } from '@/lib/supabase-server';

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
// Nothing here writes to Wix unless BOTH the env flag is on and the
// caller asked for a real run. Report mode does every read, builds
// every payload, and returns exactly what would be sent.

const WIX_API = 'https://www.wixapis.com';

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
}

export interface PushResult {
  ok: boolean;
  wrote: boolean;
  reason: string;
  counts: {
    linesConsidered: number;
    wouldBlock: number;
    wouldStayOnSale: number;
    productsTouched: number;
    skipped: number;
    failed: number;
  };
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
}

interface WixVariantStock {
  variantId?: string;
  quantity?: number;
  inStock?: boolean;
}

interface WixInventoryItem {
  id?: string;
  productId?: string;
  trackQuantity?: boolean;
  variants?: WixVariantStock[];
}

export function pushEnabled(): boolean {
  return process.env.WIX_PUSH_ENABLED === 'true';
}

async function wix(path: string, method: string, body?: unknown) {
  const res = await fetch(`${WIX_API}${path}`, {
    method,
    headers: {
      Authorization: process.env.WIX_API_KEY as string,
      'wix-site-id': process.env.WIX_SITE_ID as string,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 400); }
  return { ok: res.ok, status: res.status, body: parsed };
}

export async function pushAvailableToWix(opts: {
  /** false = report only, write nothing, whatever the env flag says. */
  write: boolean;
  source: 'cron' | 'manual';
  pushedBy?: string | null;
}): Promise<PushResult> {
  const skipped: string[] = [];
  const failures: string[] = [];

  if (!process.env.WIX_API_KEY || !process.env.WIX_SITE_ID) {
    return {
      ok: false, wrote: false, reason: 'Wix is not connected.',
      counts: { linesConsidered: 0, wouldBlock: 0, wouldStayOnSale: 0, productsTouched: 0, skipped: 0, failed: 0 },
      lines: [], skipped, failures,
    };
  }

  const supabase = createAdminSupabase();
  const [{ data: overview }, { data: items }] = await Promise.all([
    supabase.from('stock_overview').select('id, name, size, on_hand, committed, available'),
    supabase.from('stock_items').select('id, wix_product_id, wix_variant_id'),
  ]);

  const linkById = new Map(((items ?? []) as ItemRow[]).map((r) => [r.id, r]));

  // Current Wix inventory, so the log can record what each value was
  // before and report mode can show the actual change.
  const inv = await wix('/stores/v2/inventoryItems/query', 'POST', {
    query: { paging: { limit: 100 } },
  });
  if (!inv.ok) {
    return {
      ok: false, wrote: false,
      reason: `Could not read Wix inventory (HTTP ${inv.status}).`,
      counts: { linesConsidered: 0, wouldBlock: 0, wouldStayOnSale: 0, productsTouched: 0, skipped: 0, failed: 1 },
      lines: [], skipped, failures: [JSON.stringify(inv.body).slice(0, 300)],
    };
  }
  const inventory = ((inv.body as { inventoryItems?: WixInventoryItem[] }).inventoryItems) ?? [];
  const invByProduct = new Map<string, WixInventoryItem>();
  for (const i of inventory) if (i.productId) invByProduct.set(i.productId, i);

  const lines: PushLine[] = [];

  for (const row of ((overview ?? []) as OverviewRow[])) {
    const link = linkById.get(row.id);
    if (!link?.wix_product_id) continue; // not in the shop; nothing to push

    const invItem = invByProduct.get(link.wix_product_id);
    if (!invItem?.id) {
      skipped.push(`${row.name} / ${row.size}: no Wix inventory item for its product`);
      continue;
    }

    const productHasVariants = (invItem.variants ?? []).some(
      (v) => v.variantId && v.variantId !== '00000000-0000-0000-0000-000000000000'
    );
    if (productHasVariants && !link.wix_variant_id) {
      // Sending this would have to guess which variant it meant.
      skipped.push(`${row.name} / ${row.size}: product has variants but this line has no variant id`);
      continue;
    }

    const variantId = link.wix_variant_id ?? '00000000-0000-0000-0000-000000000000';
    const current = (invItem.variants ?? []).find((v) => v.variantId === variantId);

    lines.push({
      stockItemId: row.id,
      name: row.name,
      size: row.size,
      onHand: row.on_hand,
      committed: row.committed,
      available: row.available,
      setTo: Math.max(0, row.available),
      wixProductId: link.wix_product_id,
      wixVariantId: link.wix_variant_id,
      previousQuantity: typeof current?.quantity === 'number' ? current.quantity : null,
      previousTracked: invItem.trackQuantity ?? null,
    });
  }

  const byProduct = new Map<string, PushLine[]>();
  for (const l of lines) {
    const group = byProduct.get(l.wixProductId);
    if (group) group.push(l);
    else byProduct.set(l.wixProductId, [l]);
  }

  const counts = {
    linesConsidered: lines.length,
    wouldBlock: lines.filter((l) => l.setTo === 0).length,
    wouldStayOnSale: lines.filter((l) => l.setTo > 0).length,
    productsTouched: byProduct.size,
    skipped: skipped.length,
    failed: 0,
  };

  const reallyWrite = opts.write && pushEnabled();
  if (!reallyWrite) {
    return {
      ok: true,
      wrote: false,
      reason: !opts.write
        ? 'Report only — nothing was sent to Wix.'
        : 'WIX_PUSH_ENABLED is not "true", so nothing was sent to Wix.',
      counts, lines, skipped, failures,
    };
  }

  // One PATCH per product, turning tracking on as we go: a quantity
  // means nothing to Wix unless the item is tracked, so setting one
  // without the other would look like it worked and block nothing.
  const logRows: Array<Record<string, unknown>> = [];
  for (const [productId, group] of byProduct) {
    const invItem = invByProduct.get(productId);
    if (!invItem?.id) continue;

    const res = await wix(`/stores/v2/inventoryItems/${invItem.id}`, 'PATCH', {
      inventoryItem: {
        trackQuantity: true,
        variants: group.map((l) => ({
          variantId: l.wixVariantId ?? '00000000-0000-0000-0000-000000000000',
          quantity: l.setTo,
        })),
      },
    });

    if (!res.ok) {
      counts.failed += group.length;
      failures.push(`${group[0].name}: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    }

    for (const l of group) {
      logRows.push({
        stock_item_id: l.stockItemId,
        wix_product_id: l.wixProductId,
        wix_variant_id: l.wixVariantId,
        quantity: l.setTo,
        previous_quantity: l.previousQuantity,
        ok: res.ok,
        error: res.ok ? null : `HTTP ${res.status}`,
        source: opts.source,
        pushed_by: opts.pushedBy ?? null,
      });
    }
  }

  if (logRows.length > 0) {
    // Logged even when the push failed: a failed attempt is exactly
    // when you want to know what was tried.
    const { error } = await supabase.from('wix_stock_pushes').insert(logRows);
    if (error) failures.push(`push log: ${error.message}`);
  }

  return {
    ok: counts.failed === 0,
    wrote: true,
    reason: counts.failed === 0
      ? `Pushed ${lines.length} sizes across ${byProduct.size} products.`
      : `Pushed with ${counts.failed} failures.`,
    counts, lines, skipped, failures,
  };
}
