import { money } from '@/lib/types';

// The payment-link message sent by SMS or WhatsApp rather than email
// (emails often land in junk). Built in the browser from the order as
// loaded; it only ever goes to the clipboard, never through a server.
// (A "Share…" option existed briefly; its "Link shared" records still
// display via linkSharedLabel.)
//
// One message covers every unpaid item of a /sell sale (orders.sale_id).
// A single item keeps the original one-line wording.

// The shop page with the size already chosen. Checked against our store
// on 5 Nov 2026: ?variantId=<Wix variant id> preselects that size in the
// product page's dropdown. A line with no variant id keeps the plain
// page, where the customer picks the size themselves.
export function sizedProductUrl(url: string, variantId: string | null | undefined): string {
  if (!variantId) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('variantId', variantId);
    return u.toString();
  } catch {
    return url;
  }
}

// What to do on the product page. Stated even when the link preselects
// the size, so the customer can check it before adding to the cart.
export function sizeStep(size: string): string {
  return /^one size$/i.test(size.trim()) ? 'Add to cart' : `select size ${size}, then Add to cart`;
}

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
    const step = sizeStep(i.size);
    return `Hi ${first}, here's the link to pay for ${what}, ${total}: ${i.paymentUrl}. On the page, ${step}.${emailLine} Thanks, Macedon Cricket Club`;
  }

  const lines = m.items.map((i) => {
    const qty = i.quantity > 1 ? `${i.quantity} x ` : '';
    const collected = i.collected ? ', already collected' : '';
    const how = i.paymentUrl
      ? `${sizeStep(i.size)}. ${i.paymentUrl}`
      : "no online link, we'll sort this one with you";
    return `- ${qty}${i.productName}: ${how} (${money(i.quantity * i.unitPrice)}${collected})`;
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
