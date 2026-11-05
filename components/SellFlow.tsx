'use client';

import { useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-client';
import { money, sizeRank, tidyName } from '@/lib/types';
import { buildPaymentMessage, copyText, sizedProductUrl } from '@/lib/payment-message';
import CopyIcon from '@/components/CopyIcon';

export interface SellItem {
  id: string;
  name: string;
  size: string;
  price: number;
  available: number;
  image_url: string | null;
  wix_product_url: string | null;
  /** Lets the link open the shop page with this size chosen. */
  wix_variant_id: string | null;
}

type Step = 'product' | 'size' | 'who' | 'pay' | 'timing' | 'done';

/** One item of the sale being built: a stock line and how many. */
interface CartLine {
  item: SellItem;
  quantity: number;
}

interface SaleLine {
  productName: string;
  size: string;
  quantity: number;
  price: number;
  paymentUrl: string | null;
  handedOver: boolean;
  /** Not enough in the cupboard, so the row was left owed. */
  owed: boolean;
}

interface Sale {
  saleId: string;
  customerEmail: string | null;
  customerName: string;
  method: 'cash' | 'link';
  lines: SaleLine[];
  total: number;
  /** Payment-link sales only: did they walk away with anything? */
  takenNow: boolean;
  handoverFailed: boolean;
  /** null when no email was attempted (no address, or no shop link). */
  emailTo: string | null;
  emailSent: boolean;
  emailReason: string | null;
}

interface Product {
  name: string;
  image: string | null;
  available: number;
  sizes: SellItem[];
}

const STEP_LABELS: Array<[Step, string]> = [
  ['product', 'Item'],
  ['size', 'Size'],
  ['who', 'Who'],
  ['pay', 'Pay'],
];

// 'timing' is a sub-question of the Pay step rather than a fifth dot,
// so the progress row does not grow a label for it and does not appear
// to go backwards when the question opens.
function stepIndex(step: Step): number {
  if (step === 'timing') return STEP_LABELS.findIndex(([s]) => s === 'pay');
  return STEP_LABELS.findIndex(([s]) => s === step);
}

// A line is handed over only if the whole quantity is in the cupboard.
// It is never split into a handed-over part and an owed part: the
// payment-link matcher pairs a Wix line with a row of the same quantity,
// so one row per item has to stay one row.
function isShort(line: CartLine): boolean {
  return line.quantity > line.item.available;
}

// crypto.randomUUID needs a secure context; the fallback covers an
// older WebView, which is the one place /sell could meet one.
function newSaleId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export default function SellFlow({
  items,
  customers,
  sellerInitials,
}: {
  items: SellItem[];
  customers: string[];
  sellerInitials: string;
}) {
  const supabase = createClient();

  const [step, setStep] = useState<Step>('product');
  const [showAll, setShowAll] = useState(false);
  const [product, setProduct] = useState<Product | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  // Index of the cart line whose size is being changed, if any.
  const [editing, setEditing] = useState<number | null>(null);
  const [customer, setCustomer] = useState('');
  const [email, setEmail] = useState('');
  const [emailOpen, setEmailOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sale, setSale] = useState<Sale | null>(null);
  const [copied, setCopied] = useState(false);
  const [messageCopied, setMessageCopied] = useState(false);
  // Juniors / Seniors: who manages this sale's handovers (orders.order_group).
  // Defaults from the size of the first item picked; a label only, it
  // changes nothing about stock or payment.
  const [group, setGroup] = useState<'juniors' | 'seniors'>('seniors');

  // One tile per product name; each size is its own stock_items row.
  const products = useMemo(() => {
    const byName = new Map<string, Product>();
    for (const item of items) {
      const existing = byName.get(item.name);
      if (existing) {
        existing.sizes.push(item);
        existing.available += Math.max(0, item.available);
        if (!existing.image && item.image_url) existing.image = item.image_url;
      } else {
        byName.set(item.name, {
          name: item.name,
          image: item.image_url,
          available: Math.max(0, item.available),
          sizes: [item],
        });
      }
    }
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);

  const visibleProducts = showAll ? products : products.filter((p) => p.available > 0);
  const hiddenCount = products.length - visibleProducts.length;

  // Type-ahead over past customers. Suppressed once the typed text is an
  // exact match so the list does not sit over the keyboard after a tap.
  const suggestions = useMemo(() => {
    const q = customer.trim().toLowerCase();
    if (q.length < 2) return [];
    const matches = customers.filter((c) => c.toLowerCase().includes(q));
    if (matches.length === 1 && matches[0].toLowerCase() === q) return [];
    return matches.slice(0, 6);
  }, [customer, customers]);

  const total = cart.reduce((sum, l) => sum + l.item.price * l.quantity, 0);
  const allShort = cart.length > 0 && cart.every(isShort);

  function reset(keepCustomer: boolean) {
    setStep('product');
    setProduct(null);
    setCart([]);
    setEditing(null);
    setError(null);
    setSale(null);
    setCopied(false);
    setMessageCopied(false);
    setEmailOpen(false);
    if (!keepCustomer) {
      setCustomer('');
      setEmail('');
    }
  }

  // A size tapped: either a new line, one more of a line already in the
  // sale, or the new size for the line being edited. The same stock line
  // never appears twice, so each becomes exactly one order row.
  function pickSize(s: SellItem) {
    setCart((prev) => {
      if (editing !== null && prev[editing]) {
        const edited = { ...prev[editing], item: s };
        const dup = prev.findIndex((l, i) => i !== editing && l.item.id === s.id);
        if (dup === -1) return prev.map((l, i) => (i === editing ? edited : l));
        return prev
          .map((l, i) => (i === dup ? { ...l, quantity: l.quantity + edited.quantity } : l))
          .filter((_, i) => i !== editing);
      }
      const existing = prev.findIndex((l) => l.item.id === s.id);
      if (existing !== -1) {
        return prev.map((l, i) => (i === existing ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [...prev, { item: s, quantity: 1 }];
    });
    if (cart.length === 0) setGroup(/^JNR/i.test(s.size) ? 'juniors' : 'seniors');
    setEditing(null);
    setStep('who');
  }

  function setQuantity(index: number, quantity: number) {
    setCart((prev) => prev.map((l, i) => (i === index ? { ...l, quantity: Math.max(1, quantity) } : l)));
  }

  function removeLine(index: number) {
    const next = cart.filter((_, i) => i !== index);
    setCart(next);
    if (next.length === 0) {
      setProduct(null);
      setStep('product');
    }
  }

  function editLine(index: number) {
    const p = products.find((x) => x.name === cart[index].item.name);
    if (!p) return;
    setProduct(p);
    setEditing(index);
    setStep('size');
  }

  async function record(method: 'cash' | 'link', takenNow = false) {
    if (cart.length === 0) return;
    // Normalised, not just trimmed: a name typed on a phone can pick up
    // a double space mid-string as easily as a trailing one.
    const name = tidyName(customer);
    if (!name) {
      setError('Enter who this is for.');
      setStep('who');
      return;
    }

    setBusy(true);
    setError(null);

    const saleId = newSaleId();
    const now = new Date().toISOString();
    const address = email.trim();
    // Cash always leaves with them. A payment-link sale only does when
    // the coach said so — and never for a line short of stock, where
    // there is not enough in the cupboard to walk away with.
    const handsOver = (l: CartLine) => (method === 'cash' || takenNow) && !isShort(l);

    // One row per item, all in one insert, so a sale is saved whole or
    // not at all. Cash takes the money now; a payment link leaves it
    // owing. The method records what the money did, so a link is
    // 'online' even while the payment is still pending.
    const { data, error: insertError } = await supabase
      .from('orders')
      .insert(
        cart.map((l) => ({
          customer_name: name,
          customer_email: address || null,
          stock_item_id: l.item.id,
          quantity: l.quantity,
          unit_price: l.item.price,
          payment_status: method === 'cash' ? 'paid' : 'pending',
          payment_method: method === 'cash' ? 'cash' : 'online',
          source: 'manual',
          order_group: group,
          ordered_at: now,
          sale_id: saleId,
        })),
      )
      .select('id, stock_item_id');

    if (insertError || !data || data.length !== cart.length) {
      setBusy(false);
      setError(insertError?.message ?? 'Could not record the sale.');
      return;
    }
    const rowFor = new Map(data.map((r) => [r.stock_item_id as string, r.id as string]));

    // Stock only moves on an UPDATE that sets distributed_at — no INSERT
    // trigger on orders moves stock (see CLAUDE.md). Inserting with
    // distributed_at already set would hand the garment over without
    // ever reducing stock, so the handover must be a second write.
    //
    // A line short of stock is deliberately NOT handed over: it stays
    // owed and stock stays put.
    let handoverFailed = false;
    const handIds = cart.filter(handsOver).map((l) => rowFor.get(l.item.id) as string);
    if (handIds.length > 0) {
      const { error: handoverError } = await supabase
        .from('orders')
        .update({
          distributed_at: now,
          handed_over_by: sellerInitials,
          handover_note:
            method === 'cash'
              ? 'Sold at the ground'
              : 'Taken at the ground, paying online',
        })
        .in('id', handIds);
      handoverFailed = !!handoverError;
    }

    // Every payment-link sale goes through the send route, even with no
    // address or no shop page: the route records the outcome on every
    // row of the sale ("Link emailed" or "Link not sent: <why>"). One
    // call per sale, not per item — the route gathers the sale's rows
    // itself from sale_id. The order is already saved by this point, so
    // a mail failure is reported and never rolls anything back.
    let emailSent = false;
    let emailReason: string | null = null;

    if (method === 'link') {
      try {
        const res = await fetch('/api/send-payment-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: data[0].id }),
        });
        const result = await res.json();
        emailSent = !!result.sent;
        if (!emailSent) emailReason = result.reason ?? result.error ?? 'Sending failed.';
      } catch {
        // The route never answered, so it recorded nothing. Best-effort
        // note from here instead; if the connection is gone this fails
        // too, and the done screen still says the email did not send.
        emailReason = 'No connection while sending.';
        await supabase.from('orders').update({ email_error: emailReason }).eq('sale_id', saleId);
      }
    }

    const lines: SaleLine[] = cart.map((l) => ({
      productName: l.item.name,
      size: l.item.size,
      quantity: l.quantity,
      price: l.item.price,
      paymentUrl: l.item.wix_product_url
        ? sizedProductUrl(l.item.wix_product_url, l.item.wix_variant_id)
        : null,
      handedOver: handsOver(l),
      owed: isShort(l),
    }));

    setBusy(false);
    setSale({
      saleId,
      customerEmail: address || null,
      customerName: name,
      method,
      lines,
      total,
      takenNow: method === 'link' && lines.some((l) => l.handedOver),
      handoverFailed,
      // Only where an email was really attempted; no shop page has its
      // own note on the done screen.
      emailTo: method === 'link' && address && lines.some((l) => l.paymentUrl) ? address : null,
      emailSent,
      emailReason,
    });
    setStep('done');
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy — press and hold the link instead.');
    }
  }

  // Same message and record as the Orders row ⋯ menu, covering every
  // item in the sale. The clipboard is written before any await so iOS
  // still sees the tap.
  function saleMessage(s: Sale): string {
    return buildPaymentMessage({
      customerName: s.customerName,
      email: s.customerEmail,
      items: s.lines.map((l) => ({
        productName: l.productName,
        size: l.size,
        quantity: l.quantity,
        unitPrice: l.price,
        paymentUrl: l.paymentUrl,
        collected: l.handedOver,
      })),
    });
  }

  async function recordLinkShared(s: Sale, via: 'copied') {
    await supabase
      .from('orders')
      .update({ link_shared_at: new Date().toISOString(), link_shared_via: via })
      .eq('sale_id', s.saleId);
  }

  async function copyMessage(s: Sale) {
    if (!(await copyText(saleMessage(s)))) {
      setError('Could not copy the message.');
      return;
    }
    setMessageCopied(true);
    setTimeout(() => setMessageCopied(false), 2000);
    recordLinkShared(s, 'copied');
  }

  const lineLabel = (l: { quantity: number; productName: string; size: string }) =>
    `${l.quantity > 1 ? `${l.quantity} × ` : ''}${l.productName} · ${l.size}`;

  // The sale in one line, under each heading from Who onwards.
  const summary =
    cart.length === 1
      ? `${lineLabel({ quantity: cart[0].quantity, productName: cart[0].item.name, size: cart[0].item.size })} · ${money(total)}`
      : `${cart.reduce((n, l) => n + l.quantity, 0)} items · ${money(total)}`;

  const shortLines = cart.filter(isShort);
  const noPage = cart.filter((l) => !l.item.wix_product_url);

  return (
    <div className="sell">
      {step !== 'done' && (
        <ol className="sell-steps" aria-label="Progress">
          {STEP_LABELS.map(([s, label], i) => (
            <li
              key={s}
              data-state={stepIndex(step) === i ? 'now' : stepIndex(step) > i ? 'done' : 'todo'}
            >
              {label}
            </li>
          ))}
        </ol>
      )}

      {error && (
        <p className="sell-error" role="alert">
          {error}
        </p>
      )}

      {step === 'product' && (
        <section>
          <h2 className="sell-h">{cart.length > 0 ? 'What else are they taking?' : 'What are they taking?'}</h2>
          {cart.length > 0 && (
            <button className="sell-ghost" onClick={() => setStep('who')}>
              &larr; Back to the sale ({summary})
            </button>
          )}
          <div className="sell-grid">
            {visibleProducts.map((p) => (
              <button
                key={p.name}
                className="sell-card"
                onClick={() => {
                  setProduct(p);
                  setStep('size');
                }}
              >
                {p.image ? (
                  // Plain img rather than next/image: these URLs come from
                  // the Wix CDN and the host is not known ahead of time, so
                  // a next.config remotePatterns entry could not be relied
                  // on. No image falls back to the lettered tile below.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.image} alt="" className="sell-card-img" loading="lazy" />
                ) : (
                  <span className="sell-card-fallback" aria-hidden="true">
                    {p.name.slice(0, 1)}
                  </span>
                )}
                <span className="sell-card-name">{p.name}</span>
                <span className="sell-card-meta">
                  {p.available > 0 ? `${p.available} available` : 'None in stock'}
                </span>
              </button>
            ))}
          </div>

          {hiddenCount > 0 && !showAll && (
            <button className="sell-ghost" onClick={() => setShowAll(true)}>
              Show all products ({hiddenCount} with no stock)
            </button>
          )}
          {showAll && (
            <button className="sell-ghost" onClick={() => setShowAll(false)}>
              Only show what is in stock
            </button>
          )}
        </section>
      )}

      {step === 'size' && product && (
        <section>
          <h2 className="sell-h">{product.name}</h2>
          <p className="sell-sub">{editing !== null ? 'Change to which size?' : 'Which size?'}</p>
          <div className="sell-chips">
            {[...product.sizes]
              .sort((a, b) => sizeRank(a.size) - sizeRank(b.size))
              .map((s) => {
                const out = s.available <= 0;
                return (
                  <button
                    key={s.id}
                    className="sell-chip"
                    data-out={out}
                    onClick={() => pickSize(s)}
                  >
                    <span className="sell-chip-size">{s.size}</span>
                    <span className="sell-chip-count">
                      {out ? 'back-order' : `${s.available} left`}
                    </span>
                  </button>
                );
              })}
          </div>
          <p className="sell-note">
            Greyed sizes have none in the cupboard. You can still sell one — it
            is recorded as owed and nothing is handed over.
          </p>
          {editing !== null ? (
            <button
              className="sell-ghost"
              onClick={() => {
                setEditing(null);
                setStep('who');
              }}
            >
              &larr; Keep the size it was
            </button>
          ) : (
            <button
              className="sell-ghost"
              onClick={() => {
                setProduct(null);
                setStep('product');
              }}
            >
              &larr; Different item
            </button>
          )}
        </section>
      )}

      {step === 'who' && cart.length > 0 && (
        <section>
          <h2 className="sell-h">Who is it for?</h2>

          <ul className="sell-lines" aria-label="Items in this sale">
            {cart.map((l, i) => {
              const avail = Math.max(0, l.item.available);
              return (
                <li key={l.item.id} className="sell-line" data-short={isShort(l)}>
                  <button
                    className="sell-line-main"
                    onClick={() => editLine(i)}
                    aria-label={`${l.item.name} ${l.item.size}, change size`}
                  >
                    <span className="sell-line-name">{l.item.name}</span>
                    <span className="sell-line-meta">
                      <span className="size-pill">{l.item.size}</span> {money(l.item.price)}
                      {isShort(l) && (
                        <span className="sell-line-short">
                          {avail === 0 ? ' · back-order' : ` · only ${avail} in stock`}
                        </span>
                      )}
                    </span>
                  </button>
                  <div className="sell-qty" role="group" aria-label={`Quantity of ${l.item.name} ${l.item.size}`}>
                    {l.quantity === 1 ? (
                      <button className="sell-qty-btn" onClick={() => removeLine(i)} aria-label="Remove">
                        &times;
                      </button>
                    ) : (
                      <button className="sell-qty-btn" onClick={() => setQuantity(i, l.quantity - 1)} aria-label="One fewer">
                        &minus;
                      </button>
                    )}
                    <span className="sell-qty-n" aria-live="polite">{l.quantity}</span>
                    <button className="sell-qty-btn" onClick={() => setQuantity(i, l.quantity + 1)} aria-label="One more">
                      +
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          <button
            className="sell-ghost sell-add"
            onClick={() => {
              setProduct(null);
              setEditing(null);
              setStep('product');
            }}
          >
            + Add another item
          </button>

          <input
            className="sell-input"
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="words"
            placeholder="Name"
            value={customer}
            onChange={(e) => setCustomer(e.target.value)}
            autoFocus
          />
          {suggestions.length > 0 && (
            <div className="sell-suggest">
              {suggestions.map((c) => (
                <button
                  key={c}
                  className="sell-suggest-item"
                  onClick={() => setCustomer(c)}
                >
                  {c}
                </button>
              ))}
            </div>
          )}

          {emailOpen ? (
            <input
              className="sell-input"
              type="email"
              inputMode="email"
              autoComplete="off"
              autoCapitalize="none"
              placeholder="Email (optional)"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          ) : (
            <button className="sell-ghost" onClick={() => setEmailOpen(true)}>
              + Add email (optional)
            </button>
          )}

          <div className="sell-group" role="group" aria-label="Juniors or Seniors">
            {(['juniors', 'seniors'] as const).map((g) => (
              <button
                key={g}
                type="button"
                className="sell-group-btn"
                data-active={group === g}
                aria-pressed={group === g}
                onClick={() => setGroup(g)}
              >
                {g === 'juniors' ? 'Juniors' : 'Seniors'}
              </button>
            ))}
          </div>

          <button
            className="sell-primary sell-big"
            disabled={!customer.trim()}
            onClick={() => {
              setError(null);
              setStep('pay');
            }}
          >
            Continue · {money(total)}
          </button>
        </section>
      )}

      {step === 'pay' && cart.length > 0 && (
        <section>
          <h2 className="sell-h">How are they paying?</h2>
          <p className="sell-sub">
            {summary} · {customer.trim()}
          </p>
          {shortLines.length > 0 && (
            <p className="sell-warn">
              {cart.length === 1 && cart[0].item.available <= 0
                ? 'None in stock. This is recorded as owed, and nothing is handed over today.'
                : `Not enough in stock: ${shortLines
                    .map((l) => `${l.item.name} ${l.item.size} (${Math.max(0, l.item.available)} of ${l.quantity})`)
                    .join(', ')}. ${shortLines.length === 1 ? 'That line is' : 'Those lines are'} recorded as owed and not handed over today; hand ${shortLines.length === 1 ? 'it' : 'them'} over from Orders when the stock arrives.`}
            </p>
          )}
          {noPage.length > 0 && (
            <p className="sell-warn">
              {noPage.length === cart.length
                ? cart.length === 1
                  ? 'This item has no shop page recorded, so a payment link cannot be sent. Take cash, or the sale is saved as owing with no link to give them.'
                  : 'None of these items has a shop page recorded, so a payment link cannot be sent. Take cash, or the sale is saved as owing with no link to give them.'
                : `${noPage.map((l) => `${l.item.name} ${l.item.size}`).join(', ')} ${noPage.length === 1 ? 'has' : 'have'} no shop page, so the payment link will list ${noPage.length === 1 ? 'it' : 'them'} without a link.`}
            </p>
          )}
          <button
            className="sell-primary sell-big"
            disabled={busy}
            onClick={() => record('cash')}
          >
            {busy ? 'Saving…' : `Paid — cash ${money(total)}`}
          </button>
          <button
            className="sell-secondary sell-big"
            disabled={busy}
            onClick={() => {
              // Nothing that can leave today means nothing to take now,
              // so the question would be a trap. Record it as owed.
              if (allShort) record('link');
              else setStep('timing');
            }}
          >
            {busy ? 'Saving…' : 'Send payment link'}
          </button>
          <button className="sell-ghost" onClick={() => setStep('who')}>
            &larr; Back
          </button>
        </section>
      )}

      {step === 'timing' && cart.length > 0 && (
        <section>
          <h2 className="sell-h">{cart.length > 1 ? 'Are they taking them now?' : 'Are they taking it now?'}</h2>
          <p className="sell-sub">
            {summary} · {customer.trim()}
          </p>
          {shortLines.length > 0 && (
            <p className="sell-note">
              Anything short of stock stays owed either way and is not handed over.
            </p>
          )}
          <button
            className="sell-primary sell-big"
            disabled={busy}
            onClick={() => record('link', true)}
          >
            {busy ? 'Saving…' : 'Taking it now'}
            <span className="sell-btn-sub">They walk away with it · pays online after</span>
          </button>
          <button
            className="sell-secondary sell-big"
            disabled={busy}
            onClick={() => record('link', false)}
          >
            {busy ? 'Saving…' : 'Collecting later'}
            <span className="sell-btn-sub">We hold it until payment comes through</span>
          </button>
          <button className="sell-ghost" onClick={() => setStep('pay')}>
            &larr; Back
          </button>
        </section>
      )}

      {step === 'done' && sale && (() => {
        const owedLines = sale.lines.filter((l) => l.owed);
        const allOwed = owedLines.length === sale.lines.length;
        const single = sale.lines.length === 1 ? sale.lines[0] : null;
        const anyPage = sale.lines.some((l) => l.paymentUrl);
        return (
          <section>
            <div
              className="sell-done"
              data-owed={owedLines.length > 0 || sale.method === 'link'}
            >
              <span className="sell-done-badge">
                {allOwed
                  ? 'OWED — not handed over'
                  : sale.method === 'cash'
                    ? owedLines.length > 0 ? 'Paid — some still owed' : 'Handed over'
                    : sale.takenNow
                      ? 'TAKEN — payment owed'
                      : 'Awaiting payment'}
              </span>
              <h2 className="sell-done-title">
                {single ? lineLabel(single) : `${sale.lines.reduce((n, l) => n + l.quantity, 0)} items`}
              </h2>
              <p className="sell-done-who">for {sale.customerName}</p>
              <p className="sell-done-detail">
                {sale.method === 'cash'
                  ? `Cash ${money(sale.total)} taken`
                  : `${money(sale.total)} to pay online`}
              </p>

              {!single && (
                <ul className="sell-done-items">
                  {sale.lines.map((l) => (
                    <li key={`${l.productName}|${l.size}`}>
                      <span>{lineLabel(l)}</span>
                      <span className="sell-done-item-state" data-owed={l.owed}>
                        {l.owed ? 'Owed' : l.handedOver ? 'Handed over' : 'Held'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {owedLines.length > 0 && (
                <p className="sell-done-warn">
                  {single
                    ? `Nothing was handed over. ${sale.customerName} is still owed ${single.quantity > 1 ? single.quantity : 'one'} ${single.productName} in ${single.size}. It shows in Orders as waiting on stock.`
                    : `Not handed over: ${owedLines.map((l) => `${l.productName} ${l.size}`).join(', ')}. ${sale.customerName} is still owed ${owedLines.length === 1 ? 'it' : 'these'}; ${owedLines.length === 1 ? 'it shows' : 'they show'} in Orders as waiting on stock.`}
                </p>
              )}

              {sale.takenNow && (
                <p className="sell-done-warn">
                  {sale.customerName} has taken {single ? 'this' : 'the handed-over items'} with them and still owes{' '}
                  {money(sale.total)}. {single ? 'It shows' : 'They show'} in Orders under
                  &ldquo;Has gear, unpaid&rdquo; until the payment lands.
                </p>
              )}

              {sale.handoverFailed && (
                <p className="sell-done-warn">
                  The sale was recorded, but marking it handed over failed. Open
                  Orders and hand it over there, or stock will be wrong.
                </p>
              )}

              {sale.emailTo && sale.emailSent && (
                <p className="sell-done-sent">
                  Payment {single ? 'link' : 'links'} emailed to {sale.emailTo}
                </p>
              )}

              {sale.emailTo && !sale.emailSent && (
                <p className="sell-done-warn">
                  The order is saved, but the email did not send
                  {sale.emailReason ? ` (${sale.emailReason})` : ''}. Copy the{' '}
                  {single ? 'link' : 'payment message'} below and text it to them instead.
                </p>
              )}
            </div>

            {sale.method === 'link' &&
              (single?.paymentUrl ? (
                <div className="sell-link">
                  <a
                    href={single.paymentUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="sell-link-url"
                  >
                    {single.paymentUrl}
                  </a>
                  <button
                    className="sell-secondary sell-big"
                    onClick={() => copyLink(single.paymentUrl as string)}
                  >
                    <CopyIcon />
                    {copied ? 'Copied' : 'Copy link'}
                  </button>
                  <button className="sell-secondary sell-big" onClick={() => copyMessage(sale)}>
                    <CopyIcon />
                    {messageCopied ? 'Copied' : 'Copy payment message'}
                  </button>
                </div>
              ) : !single && anyPage ? (
                <div className="sell-link">
                  <button className="sell-secondary sell-big" onClick={() => copyMessage(sale)}>
                    <CopyIcon />
                    {messageCopied ? 'Copied' : 'Copy payment message'}
                  </button>
                </div>
              ) : (
                <p className="sell-note">
                  {single ? 'This item has no shop page' : 'None of these items has a shop page'} recorded, so there is no link to
                  send. Take payment another way; an admin can run the Wix
                  media sync to add the shop page.
                </p>
              ))}

            <button className="sell-primary sell-big" onClick={() => reset(true)}>
              Sell another to {sale.customerName}
            </button>
            <button className="sell-ghost" onClick={() => reset(false)}>
              Done — new customer
            </button>
          </section>
        );
      })()}
    </div>
  );
}
