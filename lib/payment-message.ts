import { money } from '@/lib/types';

// The payment-link message sent by SMS or WhatsApp rather than email
// (emails often land in junk). Built in the browser from the order as
// loaded; it only ever goes to the clipboard or the share sheet, never
// through a server.

export interface PaymentMessageInput {
  customerName: string;
  productName: string;
  size: string;
  quantity: number;
  unitPrice: number;
  paymentUrl: string;
  email: string | null;
  /** Already handed over (an unpaid order with distributed_at set). */
  collected: boolean;
}

export function buildPaymentMessage(m: PaymentMessageInput): string {
  const first = m.customerName.trim().split(/\s+/)[0] || 'there';
  const item = m.quantity > 1 ? `${m.quantity} x ${m.productName}` : m.productName;
  const what = m.collected
    ? `the ${item} (${m.size}) you've already collected`
    : `the ${item} (${m.size})`;
  const amount = money(m.quantity * m.unitPrice);
  const emailLine = m.email
    ? ` Please use ${m.email} at checkout so we can match your payment.`
    : '';
  return `Hi ${first}, here's the link to pay for ${what}, ${amount}: ${m.paymentUrl}.${emailLine} Thanks, Macedon Cricket Club`;
}

/** Phones only, in practice: desktop Chrome on Windows has navigator.share
 *  too, which is fine — it opens the OS share panel. Call after mount, not
 *  during render, or server and client markup disagree. */
export function canShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/** Must be called synchronously from the tap handler (before any await),
 *  or iOS Safari refuses for lack of a user gesture. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older WebViews and non-secure contexts have no async clipboard.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** Resolves 'shared', 'cancelled' (the person closed the sheet — not
 *  recorded), or 'failed'. Text only, no separate `url`: WhatsApp and
 *  Messages would otherwise append the link a second time. */
export async function shareText(text: string): Promise<'shared' | 'cancelled' | 'failed'> {
  try {
    await navigator.share({ text });
    return 'shared';
  } catch (e) {
    return (e as Error)?.name === 'AbortError' ? 'cancelled' : 'failed';
  }
}

export function linkSharedLabel(via: string | null | undefined, at: string): string {
  const date = new Date(at).toLocaleDateString('en-AU', { day: 'numeric', month: 'numeric' });
  return `Link ${via === 'shared' ? 'shared' : 'copied'} ${date}`;
}
