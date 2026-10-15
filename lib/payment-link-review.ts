import type { SupabaseClient } from '@supabase/supabase-js';
import {
  matchPaymentLinks,
  toManualCandidate,
  toPaidWixLine,
  WINDOW_DAYS,
  type ConfirmReason,
  type ManualOrderCandidate,
  type NearMissReason,
  type OrderRow,
  type PaidWixLine,
  type StockLabel,
} from '@/lib/payment-link-match';

// The Admin page's "Payment-link matches" list, and the data the
// reconciliation dry run reports. Worked out live from the database on
// every load, never stored: anything wix-sync did not merge is sitting
// in `orders` as two rows (the open /sell order and the paid Wix
// order), so running the same matcher over what is already imported
// finds it again. The only stored state is which pairs an admin has
// dismissed (payment_match_dismissals).
//
// Callers must have checked the viewer is an admin and pass the
// service-role client: dismissals are not readable any other way.

export type ReviewKind = 'auto' | 'confirm' | 'near-miss';

export interface ReviewOrder {
  orderId: string;
  reference: string;
  name: string;
  email: string | null;
  item: string;
  quantity: number;
  orderedAt: string;
  handedOver: boolean;
  wixOrderNumber?: string | null;
}

export interface ReviewPair {
  kind: ReviewKind;
  /** Plain-English reasons, already worded for the screen. */
  reasons: string[];
  manual: ReviewOrder;
  wix: ReviewOrder;
  /** Null when an admin can approve it; otherwise why not. */
  blocked: string | null;
}

const CONFIRM_TEXT: Record<ConfirmReason, string> = {
  'several-candidates': 'More than one open order could be this payment',
  'older-than-window': `Order placed more than ${WINDOW_DAYS} days before the payment`,
  'wix-already-handed-over': 'The Wix order is already marked handed over',
  'manual-already-matched': 'That open order already matches an earlier payment',
};

const NEAR_MISS_TEXT: Record<NearMissReason, string> = {
  'different-size': 'Different size',
  'different-quantity': 'Different quantity',
  'different-email': 'Different email',
};

// Mirrors the refusals in merge_payment_link_order(), so the screen
// does not offer a button the database will refuse.
function blockedReason(m: ManualOrderCandidate, w: PaidWixLine): string | null {
  if (w.handedOver) return 'The Wix order is marked handed over, so merging could move stock wrongly. Sort this one out by hand.';
  if (m.stockItemId !== w.stockItemId) return 'Different size: merging would need the order changed first.';
  if (m.quantity !== w.quantity) return 'Different quantity: merging would need the order changed first.';
  return null;
}

export function buildReviewList(
  manualRows: OrderRow[],
  wixRows: OrderRow[],
  stockRows: { id: string; name: string; size: string }[],
  dismissed: Set<string>,
): ReviewPair[] {
  const stock = new Map<string, StockLabel>(stockRows.map((s) => [s.id, { name: s.name, size: s.size }]));
  const result = matchPaymentLinks(manualRows.map(toManualCandidate), wixRows.map(toPaidWixLine), stock);

  const item = (id: string | null) => {
    const s = id ? stock.get(id) : undefined;
    return s ? `${s.name} ${s.size}` : 'Unknown item';
  };
  const manualView = (m: ManualOrderCandidate): ReviewOrder => ({
    orderId: m.id, reference: m.reference, name: m.customerName, email: m.customerEmail,
    item: item(m.stockItemId), quantity: m.quantity, orderedAt: m.orderedAt, handedOver: m.distributedAt !== null,
  });
  const wixView = (w: PaidWixLine): ReviewOrder => ({
    orderId: w.rowId as string, reference: w.reference ?? '', name: w.customerName, email: w.customerEmail,
    item: item(w.stockItemId), quantity: w.quantity, orderedAt: w.orderedAt, handedOver: w.handedOver,
    wixOrderNumber: w.wixOrderNumber,
  });

  const pairs: ReviewPair[] = [];
  const add = (kind: ReviewKind, reasons: string[], m: ManualOrderCandidate, w: PaidWixLine) => {
    if (dismissed.has(`${m.id}::${w.rowId}`)) return;
    pairs.push({ kind, reasons, manual: manualView(m), wix: wixView(w), blocked: blockedReason(m, w) });
  };

  // Pairs that would have merged on their own but are both still in
  // the database: the sync flag was off when the payment came in.
  for (const p of result.autoMerge) add('auto', ['Same email, item and quantity'], p.manual, p.wix);
  for (const c of result.needsConfirmation) {
    for (const m of c.manuals) add('confirm', [CONFIRM_TEXT[c.reason]], m, c.wix);
  }
  for (const n of result.nearMisses) add('near-miss', n.reasons.map((r) => NEAR_MISS_TEXT[r]), n.manual, n.wix);

  return pairs;
}

const ORDER_COLUMNS =
  'id, reference, customer_name, customer_email, stock_item_id, quantity, ordered_at, distributed_at, wix_order_id, wix_order_number, notes';

export async function loadMatchInputs(db: SupabaseClient) {
  const [manualRes, wixRes, stockRes, dismissRes] = await Promise.all([
    db.from('orders').select(ORDER_COLUMNS)
      .eq('source', 'manual').eq('payment_status', 'pending').is('wix_order_id', null),
    db.from('orders').select(ORDER_COLUMNS)
      .eq('source', 'wix').eq('payment_status', 'paid').not('stock_item_id', 'is', null),
    db.from('stock_items').select('id, name, size'),
    db.from('payment_match_dismissals').select('manual_order_id, wix_order_row_id'),
  ]);
  const error = manualRes.error ?? wixRes.error ?? stockRes.error ?? dismissRes.error;
  if (error) throw new Error(error.message);

  return {
    manualRows: (manualRes.data ?? []) as OrderRow[],
    wixRows: (wixRes.data ?? []) as OrderRow[],
    stockRows: (stockRes.data ?? []) as { id: string; name: string; size: string }[],
    dismissed: new Set(
      ((dismissRes.data ?? []) as { manual_order_id: string; wix_order_row_id: string }[])
        .map((d) => `${d.manual_order_id}::${d.wix_order_row_id}`),
    ),
  };
}

export async function loadReviewList(db: SupabaseClient): Promise<ReviewPair[]> {
  const i = await loadMatchInputs(db);
  return buildReviewList(i.manualRows, i.wixRows, i.stockRows, i.dismissed);
}
