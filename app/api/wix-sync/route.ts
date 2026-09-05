import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase-server';

// This endpoint pulls the FULL order history from the Wix store and
// records it. It pages through every order (no lookback window), so it
// can be re-run safely to catch up on anything missed. Each order can
// import as several rows (one per line item), all sharing the same
// wix_order_id, so duplicates are filtered on the (wix_order_id,
// stock_item_id) pair rather than wix_order_id alone — see
// migration-005 and migration-006.
//
// Orders whose Wix fulfillmentStatus is FULFILLED are inserted with
// distributed_at already set, so they don't show up in Handovers as
// "ready to hand over" — they were already handed over before this
// tracker existed. Orders that aren't fulfilled are inserted with
// distributed_at left null, same as any other manual order.
//
// IMPORTANT: distributed_at is set in the same INSERT as the rest of
// the row, not via a follow-up UPDATE. The stock-reduction trigger on
// `orders` fires AFTER UPDATE (moved there in migration-002 so stock
// only moves on handover, not on sale) — it does not fire on INSERT.
// Setting distributed_at at insert time means already-fulfilled
// historical orders are recorded as handed over WITHOUT re-deducting
// stock we already counted in the March stocktake. If this were done
// as insert-then-update instead, the UPDATE would fire the trigger and
// wrongly reduce stock a second time.
//
// migration-002 isn't in this repo (see supabase/MIGRATIONS.md), so
// this reasoning is based on its documented intent, not a direct read
// of the live trigger definition — worth confirming against the
// actual trigger in Supabase before relying on it in production.
//
// PERFORMANCE: this does exactly 3 Supabase calls total, regardless
// of how many orders are imported — one read of existing (wix_order_id,
// stock_item_id) pairs, one read of the stock list, and one bulk
// upsert of every new row. Everything else (matching, deduping,
// building the row list) happens in memory. Wix pagination stops once
// `limit` orders have been fetched (default 500, see the ?limit=
// query param) so a very large store can be imported in a few
// separate requests if one run isn't enough to stay under Vercel's
// Hobby-plan 60s function limit. There's no persisted cursor between
// requests, so re-running with the same limit re-fetches the same
// first N orders from Wix — harmless, since the duplicate guard and
// the unique constraint both skip anything already imported, but it
// won't reach further orders on its own. Raise ?limit= to cover more
// in one run instead.

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DEFAULT_LIMIT = 500;

interface WixLineItem {
  catalogReference?: {
    catalogItemId?: string;
    options?: { variantId?: string; options?: Record<string, string> };
  };
  productName?: { original?: string };
  quantity?: number;
  price?: { amount?: string };
}

interface UnmatchedLine {
  productName: string;
  productId: string;
  variantId: string;
  size: string;
  count: number;
}

interface WixFulfillment {
  dateCreated?: string;
}

interface WixOrder {
  id: string;
  number?: string;
  createdDate?: string;
  paymentStatus?: string;
  fulfillmentStatus?: 'NOT_FULFILLED' | 'PARTIALLY_FULFILLED' | 'FULFILLED' | string;
  fulfillments?: WixFulfillment[];
  buyerInfo?: { email?: string };
  recipientInfo?: { contactDetails?: { firstName?: string; lastName?: string } };
  billingInfo?: { contactDetails?: { firstName?: string; lastName?: string } };
  lineItems?: WixLineItem[];
}

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization');
  return header === `Bearer ${secret}`;
}

// Pages through cursorPaging, stopping once `limit` orders have been
// collected (or Wix runs out of pages first).
async function fetchWixOrders(limit: number): Promise<WixOrder[]> {
  const all: WixOrder[] = [];
  let cursor: string | undefined;

  do {
    const res = await fetch('https://www.wixapis.com/ecom/v1/orders/search', {
      method: 'POST',
      headers: {
        Authorization: process.env.WIX_API_KEY!,
        'wix-site-id': process.env.WIX_SITE_ID!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        search: {
          cursorPaging: { limit: 100, cursor },
        },
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Wix API returned ${res.status}: ${detail.slice(0, 300)}`);
    }

    const data = await res.json();
    all.push(...(data.orders ?? []));
    cursor = data.metadata?.cursors?.next ?? undefined;
  } while (cursor && all.length < limit);

  return all.slice(0, limit);
}

function fulfilmentTimestamp(order: WixOrder): string {
  return order.fulfillments?.[0]?.dateCreated ?? order.createdDate ?? new Date().toISOString();
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: 'Not authorised' }, { status: 401 });
  }

  if (!process.env.WIX_API_KEY || !process.env.WIX_SITE_ID) {
    return NextResponse.json(
      { error: 'Wix is not connected yet. Add WIX_API_KEY and WIX_SITE_ID.' },
      { status: 400 }
    );
  }

  const limitParam = Number(req.nextUrl.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : DEFAULT_LIMIT;

  const supabase = createAdminSupabase();

  let wixOrders: WixOrder[];
  try {
    wixOrders = await fetchWixOrders(limit);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not reach Wix' },
      { status: 502 }
    );
  }

  // Which (Wix order, stock item) line pairs do we already have? A
  // multi-item Wix order imports as one row per line item, all sharing
  // the same wix_order_id, so the duplicate guard has to be keyed on
  // the pair, not wix_order_id alone (see migration-005 and
  // migration-006, which is what makes the pair usable as this
  // route's upsert conflict target). One query.
  const { data: existing } = await supabase
    .from('orders')
    .select('wix_order_id, stock_item_id')
    .not('wix_order_id', 'is', null);

  const seen = new Set((existing ?? []).map((o) => `${o.wix_order_id}::${o.stock_item_id ?? ''}`));

  // Load the stock list so we can match Wix products to our rows. One query.
  const { data: stock } = await supabase
    .from('stock_items')
    .select('id, name, size, price, wix_product_id, wix_variant_id');

  type StockRow = {
    id: string; name: string; size: string; price: number;
    wix_product_id: string | null; wix_variant_id: string | null;
  };
  const rows = (stock ?? []) as StockRow[];

  const byWixId = new Map<string, StockRow>();
  const byName = new Map<string, StockRow>();
  for (const s of rows) {
    if (s.wix_product_id) {
      byWixId.set(`${s.wix_product_id}::${s.wix_variant_id ?? ''}`, s);
      byWixId.set(s.wix_product_id, s);
    }
    byName.set(`${s.name.toLowerCase()}::${s.size.toLowerCase()}`, s);
  }

  // ---- Build every row to insert in memory, no DB calls here ----
  const toInsert: Record<string, unknown>[] = [];
  const unmatched = new Map<string, UnmatchedLine>();
  let fulfilled = 0;
  let awaitingHandover = 0;

  for (const order of wixOrders) {
    if (order.paymentStatus !== 'PAID') continue;

    const contact =
      order.recipientInfo?.contactDetails ?? order.billingInfo?.contactDetails ?? {};
    const customerName =
      [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Wix customer';

    const isFulfilled = order.fulfillmentStatus === 'FULFILLED';

    for (const line of order.lineItems ?? []) {
      const productId = line.catalogReference?.catalogItemId ?? '';
      const variantId = line.catalogReference?.options?.variantId ?? '';
      const productName = line.productName?.original ?? '';
      const choices = line.catalogReference?.options?.options ?? {};
      const size = choices.Size ?? (Object.values(choices).join(' / ') || '');

      const match =
        byWixId.get(`${productId}::${variantId}`) ??
        byWixId.get(productId) ??
        byName.get(`${productName.toLowerCase()}::`) ??
        null;

      if (!match) {
        const key = `${productId}::${variantId}::${size}`;
        const existingEntry = unmatched.get(key);
        if (existingEntry) {
          existingEntry.count += 1;
        } else {
          unmatched.set(key, {
            productName: productName || 'Unknown product',
            productId,
            variantId,
            size,
            count: 1,
          });
        }
        continue;
      }

      const lineKey = `${order.id}::${match.id}`;
      if (seen.has(lineKey)) continue;
      seen.add(lineKey); // guards against the same pair appearing twice in this batch

      const distributedAt = isFulfilled ? fulfilmentTimestamp(order) : null;
      if (isFulfilled) fulfilled += 1; else awaitingHandover += 1;

      toInsert.push({
        customer_name: customerName,
        customer_email: order.buyerInfo?.email ?? null,
        stock_item_id: match.id,
        quantity: line.quantity ?? 1,
        unit_price: Number(line.price?.amount ?? match.price ?? 0),
        payment_status: 'paid',
        source: 'wix',
        wix_order_id: order.id,
        ordered_at: order.createdDate ?? new Date().toISOString(),
        distributed_at: distributedAt,
        notes: order.number ? `Wix order #${order.number}` : null,
      });
    }
  }

  // ---- One bulk write for everything gathered above ----
  // distributed_at is set here, in the same INSERT as the rest of the
  // row, so the AFTER UPDATE stock trigger never fires for historical
  // imports — see the note at the top of this file. ignoreDuplicates
  // is a safety net on top of the in-memory `seen` check above.
  if (toInsert.length > 0) {
    const { error } = await supabase
      .from('orders')
      .upsert(toInsert, { onConflict: 'wix_order_id,stock_item_id', ignoreDuplicates: true });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    totalFetched: wixOrders.length,
    imported: toInsert.length,
    fulfilled,
    awaitingHandover,
    unmatched: Array.from(unmatched.values()),
    message: unmatched.size
      ? 'Some Wix products are not linked to a stock item yet. Add their Wix product ID in the app.'
      : 'Sync complete.',
    ranAt: new Date().toISOString(),
  });
}
