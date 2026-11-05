import { money } from '@/lib/types';

// The payment-link message sent by SMS or WhatsApp rather than email
// (emails often land in junk). Built in the browser from the order as
// loaded; it only ever goes to the clipboard, never through a server.
// (A "Share…" option existed briefly; its "Link shared" records still
// display via linkSharedLabel.)
//
// One message covers every unpaid item of a /sell sale (orders.sale_id).
// A single item keeps the original one-line wording.

export interface PaymentMessageItem {
  productName: string;
  size: string;
  quantity: number;
  unitPrice: number;
  /** null when the item has no shop page; it is still listed. */
  paymentUrl: string | null;
  /** Already handed over (an unpaid order with distributed_at set). */
  collected: boolean;
}

export interface PaymentMessageInput {
  customerName: string;
  email: string | null;
  items: PaymentMessageItem[];
}

export function buildPaymentMessage(m: PaymentMessageInput): string {
  const first = m.customerName.trim().split(/\s+/)[0] || 'there';
  const total = money(m.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0));

  if (m.items.length === 1 && m.items[0].paymentUrl) {
    const i = m.items[0];
    const item = i.quantity > 1 ? `${i.quantity} x ${i.productName}` : i.productName;
    const what = i.collected
      ? `the ${item} (${i.size}) you've already collected`
      : `the ${item} (${i.size})`;
    const emailLine = m.email
      ? ` Please use ${m.email} at checkout so we can match your payment.`
      : '';
    return `Hi ${first}, here's the link to pay for ${what}, ${total}: ${i.paymentUrl}.${emailLine} Thanks, Macedon Cricket Club`;
  }

  const lines = m.items.map((i) => {
    const qty = i.quantity > 1 ? `${i.quantity} x ` : '';
    const collected = i.collected ? ', already collected' : '';
    const link = i.paymentUrl ?? "no online link, we'll sort this one with you";
    return `- ${qty}${i.productName} (${i.size}), ${money(i.quantity * i.unitPrice)}${collected}: ${link}`;
  });
  const checkout = m.email
    ? `Add each item to your cart, then check out once using ${m.email}.`
    : 'Add each item to your cart, then check out once.';
  return [
    `Hi ${first}, here are the links to pay for your order, ${total} in total:`,
    ...lines,
    checkout,
    'Thanks, Macedon Cricket Club',
  ].join('\n');
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

export function linkSharedLabel(via: string | null | undefined, at: string): string {
  const date = new Date(at).toLocaleDateString('en-AU', { day: 'numeric', month: 'numeric' });
  return `Link ${via === 'shared' ? 'shared' : 'copied'} ${date}`;
}
