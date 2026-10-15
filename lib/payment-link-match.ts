// Matches a /sell payment-link order to the Wix order that paid for it.
//
// A payment link only opens the Wix product page, so when the customer
// pays, Wix creates an order of its own and wix-sync imports it as a
// second row while the /sell row stays unpaid. This module decides
// which of those pairs are the same sale. It is pure — no database, no
// Wix — so the daily sync (lines not yet inserted) and the one-off
// reconciliation (Wix rows already imported) run exactly the same rule.
//
// Email, not name: the coach types the child's name at the ground and
// the parent pays under their own.
//
// A pair merges automatically only when there is no doubt:
//   - the manual order is open: source manual, pending, no wix_order_id
//   - same email (case-insensitive), same stock item, same quantity
//   - the manual order was placed before the Wix order, by no more
//     than WINDOW_DAYS
//   - exactly one such manual order, not already claimed by an earlier
//     Wix line (one-to-one; Wix lines are taken oldest first)
//   - the Wix line is not handed over. wix-sync inserts a Wix-FULFILLED
//     order with distributed_at already set and no stock movement, so a
//     handed-over Wix row does not tell us whether stock actually moved,
//     and merging it could deduct or restore stock wrongly.
// Anything short of that is listed for a person to confirm, never
// merged. Same email and product but a different size or quantity, or
// same item but a different email, is listed as a near-miss.

export const WINDOW_DAYS = 30;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

export interface ManualOrderCandidate {
  id: string;
  reference: string;
  customerName: string;
  customerEmail: string | null;
  stockItemId: string | null;
  quantity: number;
  orderedAt: string;
  distributedAt: string | null;
}

export interface PaidWixLine {
  /** orders.id when already imported; null for a line wix-sync has not inserted yet. */
  rowId: string | null;
  reference: string | null;
  wixOrderId: string;
  wixOrderNumber: string | null;
  customerName: string;
  customerEmail: string | null;
  stockItemId: string;
  quantity: number;
  orderedAt: string;
  /** distributed_at set on the row, or Wix says FULFILLED for a line not yet inserted. */
  handedOver: boolean;
}

export interface StockLabel {
  name: string;
  size: string;
}

export type ConfirmReason =
  | 'several-candidates'
  | 'older-than-window'
  | 'wix-already-handed-over'
  | 'manual-already-matched';

export type NearMissReason = 'different-size' | 'different-quantity' | 'different-email';

export interface AutoMerge {
  manual: ManualOrderCandidate;
  wix: PaidWixLine;
}

export interface NeedsConfirmation {
  reason: ConfirmReason;
  wix: PaidWixLine;
  manuals: ManualOrderCandidate[];
}

export interface NearMiss {
  reasons: NearMissReason[];
  manual: ManualOrderCandidate;
  wix: PaidWixLine;
}

export interface MatchResult {
  autoMerge: AutoMerge[];
  needsConfirmation: NeedsConfirmation[];
  nearMisses: NearMiss[];
}

function sameEmail(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function placedBefore(manual: ManualOrderCandidate, wix: PaidWixLine): boolean {
  return Date.parse(manual.orderedAt) < Date.parse(wix.orderedAt);
}

function withinWindow(manual: ManualOrderCandidate, wix: PaidWixLine): boolean {
  return Date.parse(wix.orderedAt) - Date.parse(manual.orderedAt) <= WINDOW_MS;
}

function byOrderedAt<T extends { orderedAt: string }>(a: T, b: T): number {
  return Date.parse(a.orderedAt) - Date.parse(b.orderedAt);
}

/**
 * Callers pass only open manual orders (source manual, pending, no
 * wix_order_id) and only paid Wix lines; this does not re-check status.
 * `stock` is only used for the near-miss product comparison (same name,
 * different size).
 */
export function matchPaymentLinks(
  manuals: ManualOrderCandidate[],
  wixLines: PaidWixLine[],
  stock: Map<string, StockLabel>,
): MatchResult {
  const result: MatchResult = { autoMerge: [], needsConfirmation: [], nearMisses: [] };
  const claimed = new Set<string>();
  const sortedManuals = [...manuals].sort(byOrderedAt);

  for (const wix of [...wixLines].sort(byOrderedAt)) {
    const earlier = sortedManuals.filter((m) => placedBefore(m, wix));

    const exact = earlier.filter(
      (m) =>
        sameEmail(m.customerEmail, wix.customerEmail) &&
        m.stockItemId === wix.stockItemId &&
        m.quantity === wix.quantity,
    );
    const inWindow = exact.filter((m) => withinWindow(m, wix));
    const unclaimed = inWindow.filter((m) => !claimed.has(m.id));

    if (exact.length > 0) {
      if (inWindow.length === 0) {
        result.needsConfirmation.push({ reason: 'older-than-window', wix, manuals: exact });
      } else if (unclaimed.length === 0) {
        result.needsConfirmation.push({ reason: 'manual-already-matched', wix, manuals: inWindow });
      } else if (unclaimed.length > 1) {
        result.needsConfirmation.push({ reason: 'several-candidates', wix, manuals: unclaimed });
      } else if (wix.handedOver) {
        result.needsConfirmation.push({ reason: 'wix-already-handed-over', wix, manuals: unclaimed });
      } else {
        claimed.add(unclaimed[0].id);
        result.autoMerge.push({ manual: unclaimed[0], wix });
      }
    }

    // Near-misses: only within the window, and only for manual orders
    // that are not an exact match for this line (those are covered above).
    const wixLabel = stock.get(wix.stockItemId);
    for (const m of earlier) {
      if (exact.includes(m) || !withinWindow(m, wix) || !m.stockItemId) continue;
      const emailMatch = sameEmail(m.customerEmail, wix.customerEmail);
      const sameItem = m.stockItemId === wix.stockItemId;
      const mLabel = stock.get(m.stockItemId);
      const sameProduct = !!wixLabel && !!mLabel && wixLabel.name === mLabel.name;

      const reasons: NearMissReason[] = [];
      if (emailMatch && sameProduct) {
        if (!sameItem) reasons.push('different-size');
        if (m.quantity !== wix.quantity) reasons.push('different-quantity');
      } else if (!emailMatch && sameItem) {
        reasons.push('different-email');
      }
      if (reasons.length > 0) result.nearMisses.push({ reasons, manual: m, wix });
    }
  }

  return result;
}

// The note a merged order carries. The manual order keeps its own name
// and email; the payer is recorded here, with their email only when it
// differs (possible only for a pair approved by hand, since an
// automatic merge requires the same email).
export function mergeNote(wix: PaidWixLine, manualEmail: string | null): string {
  const order = wix.wixOrderNumber ? `Wix order #${wix.wixOrderNumber}` : `Wix order ${wix.wixOrderId}`;
  const email = wix.customerEmail && !sameEmail(wix.customerEmail, manualEmail)
    ? ` (${wix.customerEmail.trim()})`
    : '';
  return `${order}, paid online by ${wix.customerName}${email}`;
}

// ---- Report for the reconciliation dry run ----

export interface OrderRow {
  id: string;
  reference: string;
  customer_name: string;
  customer_email: string | null;
  stock_item_id: string | null;
  quantity: number;
  ordered_at: string;
  distributed_at: string | null;
  wix_order_id: string | null;
  wix_order_number?: string | null;
  notes: string | null;
}

export function toManualCandidate(o: OrderRow): ManualOrderCandidate {
  return {
    id: o.id,
    reference: o.reference,
    customerName: o.customer_name,
    customerEmail: o.customer_email,
    stockItemId: o.stock_item_id,
    quantity: o.quantity,
    orderedAt: o.ordered_at,
    distributedAt: o.distributed_at,
  };
}

export function toPaidWixLine(o: OrderRow): PaidWixLine {
  return {
    rowId: o.id,
    reference: o.reference,
    wixOrderId: o.wix_order_id ?? '',
    // The column is filled from 15 Oct 2026; older rows only have it in the note.
    wixOrderNumber: o.wix_order_number ?? o.notes?.match(/#(\d+)/)?.[1] ?? null,
    customerName: o.customer_name,
    customerEmail: o.customer_email,
    stockItemId: o.stock_item_id as string,
    quantity: o.quantity,
    orderedAt: o.ordered_at,
    handedOver: o.distributed_at !== null,
  };
}

export function buildReport(
  manualRows: OrderRow[],
  wixRows: OrderRow[],
  stockRows: { id: string; name: string; size: string }[],
) {
  const stock = new Map<string, StockLabel>(stockRows.map((s) => [s.id, { name: s.name, size: s.size }]));

  const manuals = manualRows.map(toManualCandidate);
  const wixLines = wixRows.map(toPaidWixLine);

  const result = matchPaymentLinks(manuals, wixLines, stock);

  const item = (id: string | null) => {
    const s = id ? stock.get(id) : undefined;
    return s ? `${s.name} ${s.size}` : 'Unknown item';
  };
  const describeManual = (m: ManualOrderCandidate) => ({
    orderId: m.id,
    reference: m.reference,
    name: m.customerName,
    email: m.customerEmail,
    item: item(m.stockItemId),
    quantity: m.quantity,
    orderedAt: m.orderedAt,
    handedOver: m.distributedAt !== null,
  });
  const describeWix = (w: PaidWixLine) => ({
    orderId: w.rowId,
    reference: w.reference,
    wixOrderId: w.wixOrderId,
    wixOrderNumber: w.wixOrderNumber,
    name: w.customerName,
    email: w.customerEmail,
    item: item(w.stockItemId),
    quantity: w.quantity,
    orderedAt: w.orderedAt,
    handedOver: w.handedOver,
  });

  return {
    windowDays: WINDOW_DAYS,
    openManualOrders: manuals.length,
    paidWixLines: wixLines.length,
    autoMerge: result.autoMerge.map((p) => ({ manual: describeManual(p.manual), wix: describeWix(p.wix) })),
    needsConfirmation: result.needsConfirmation.map((c) => ({
      reason: c.reason,
      wix: describeWix(c.wix),
      manuals: c.manuals.map(describeManual),
    })),
    nearMisses: result.nearMisses.map((n) => ({
      reasons: n.reasons,
      manual: describeManual(n.manual),
      wix: describeWix(n.wix),
    })),
  };
}
