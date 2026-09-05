import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase-server';

// This endpoint pulls the FULL order history from the Wix store and
// records it. It pages through every order (no lookback window), so it
// can be re-run safely to catch up on anything missed. Each order can
// import as several rows (one per line item), all sharing the same
// wix_order_id, so duplicates are filtered on the (wix_order_id,
// stock_item_id) pair rather than wix_order_id alone — see
// migration-005.
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

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface WixLineItem {
  catalogReference?: { catalogItemId?: string; options?: { variantId?: string } };
  productName?: { original?: string };
  quantity?: number;
  price?: { amount?: string };
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

// Pages through cursorPaging until Wix stops returning a next cursor,
// so this pulls the entire order history rather than a lookback window.
async function fetchAllWixOrders(): Promise<WixOrder[]> {
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
  } while (cursor);

  return all;
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

  const supabase = createAdminSupabase();

  let wixOrders: WixOrder[];
  try {
    wixOrders = await fetchAllWixOrders();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not reach Wix' },
      { status: 502 }
    );
  }

  // Which (Wix order, stock item) line pairs do we already have? A
  // multi-item Wix order imports as one row per line item, all sharing
  // the same wix_order_id, so the duplicate guard has to be keyed on
  // the pair, not wix_order_id alone (see migration-005).
  const { data: existing } = await supabase
    .from('orders')
    .select('wix_order_id, stock_item_id')
    .not('wix_order_id', 'is', null);

  const seen = new Set((existing ?? []).map((o) => `${o.wix_order_id}::${o.stock_item_id ?? ''}`));

  // Load the stock list so we can match Wix products to our rows.
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

  let imported = 0;
  let fulfilled = 0;
  let awaitingHandover = 0;
  const unmatched: string[] = [];

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

      const match =
        byWixId.get(`${productId}::${variantId}`) ??
        byWixId.get(productId) ??
        byName.get(`${productName.toLowerCase()}::`) ??
        null;

      if (!match) {
        unmatched.push(productName || productId || 'unknown product');
        continue;
      }

      const lineKey = `${order.id}::${match.id}`;
      if (seen.has(lineKey)) continue;

      // distributed_at is set here, in the INSERT itself, so the
      // AFTER UPDATE stock trigger never fires for historical imports —
      // see the note at the top of this file.
      const { error } = await supabase.from('orders').insert({
        customer_name: customerName,
        customer_email: order.buyerInfo?.email ?? null,
        stock_item_id: match.id,
        quantity: line.quantity ?? 1,
        unit_price: Number(line.price?.amount ?? match.price ?? 0),
        payment_status: 'paid',
        source: 'wix',
        wix_order_id: order.id,
        ordered_at: order.createdDate ?? new Date().toISOString(),
        distributed_at: isFulfilled ? fulfilmentTimestamp(order) : null,
        notes: order.number ? `Wix order #${order.number}` : null,
      });

      if (!error) {
        seen.add(lineKey);
        imported += 1;
        if (isFulfilled) fulfilled += 1;
        else awaitingHandover += 1;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    totalFetched: wixOrders.length,
    imported,
    fulfilled,
    awaitingHandover,
    unmatched: Array.from(new Set(unmatched)),
    message: unmatched.length
      ? 'Some Wix products are not linked to a stock item yet. Add their Wix product ID in the app.'
      : 'Sync complete.',
    ranAt: new Date().toISOString(),
  });
}
