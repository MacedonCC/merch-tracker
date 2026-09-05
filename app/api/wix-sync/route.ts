import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase-server';

// This endpoint pulls recent paid orders from the Wix store and records them.
// It runs automatically on a schedule (see vercel.json) and can also be
// triggered by the "Sync now" button in the app.
//
// It is safe to run repeatedly: orders are keyed on wix_order_id, which is
// unique, so an order that has already been imported is skipped rather than
// duplicated.

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface WixLineItem {
  catalogReference?: { catalogItemId?: string; options?: { variantId?: string } };
  productName?: { original?: string };
  quantity?: number;
  price?: { amount?: string };
}

interface WixOrder {
  id: string;
  number?: string;
  createdDate?: string;
  paymentStatus?: string;
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

async function fetchWixOrders(since: string): Promise<WixOrder[]> {
  const res = await fetch('https://www.wixapis.com/ecom/v1/orders/search', {
    method: 'POST',
    headers: {
      Authorization: process.env.WIX_API_KEY!,
      'wix-site-id': process.env.WIX_SITE_ID!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      search: {
        filter: { createdDate: { $gte: since } },
        cursorPaging: { limit: 100 },
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Wix API returned ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.orders ?? [];
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

  // Look back 7 days. Duplicates are filtered out below, so overlap is fine.
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  let wixOrders: WixOrder[];
  try {
    wixOrders = await fetchWixOrders(since);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not reach Wix' },
      { status: 502 }
    );
  }

  // Which Wix orders do we already have?
  const { data: existing } = await supabase
    .from('orders')
    .select('wix_order_id')
    .not('wix_order_id', 'is', null);

  const seen = new Set((existing ?? []).map((o) => o.wix_order_id));

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

  const imported: string[] = [];
  const unmatched: string[] = [];

  for (const order of wixOrders) {
    if (seen.has(order.id)) continue;
    if (order.paymentStatus !== 'PAID') continue;

    const contact =
      order.recipientInfo?.contactDetails ?? order.billingInfo?.contactDetails ?? {};
    const customerName =
      [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Wix customer';

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
        notes: order.number ? `Wix order #${order.number}` : null,
      });

      // The database trigger reduces stock automatically on insert.
      if (!error) imported.push(order.id);
    }
  }

  return NextResponse.json({
    ok: true,
    checked: wixOrders.length,
    imported: imported.length,
    unmatched: Array.from(new Set(unmatched)),
    message: unmatched.length
      ? 'Some Wix products are not linked to a stock item yet. Add their Wix product ID in the app.'
      : 'Sync complete.',
    ranAt: new Date().toISOString(),
  });
}
