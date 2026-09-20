'use client';

import { useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-client';
import { money, sizeRank } from '@/lib/types';

export interface SellItem {
  id: string;
  name: string;
  size: string;
  price: number;
  available: number;
  image_url: string | null;
  wix_product_url: string | null;
}

type Step = 'product' | 'size' | 'who' | 'pay' | 'done';

interface Sale {
  productName: string;
  size: string;
  customerName: string;
  price: number;
  method: 'cash' | 'link';
  backorder: boolean;
  paymentUrl: string | null;
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

function stepIndex(step: Step): number {
  return STEP_LABELS.findIndex(([s]) => s === step);
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
  const [chosen, setChosen] = useState<SellItem | null>(null);
  const [customer, setCustomer] = useState('');
  const [email, setEmail] = useState('');
  const [emailOpen, setEmailOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sale, setSale] = useState<Sale | null>(null);
  const [copied, setCopied] = useState(false);

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

  function reset(keepCustomer: boolean) {
    setStep('product');
    setProduct(null);
    setChosen(null);
    setError(null);
    setSale(null);
    setCopied(false);
    setEmailOpen(false);
    if (!keepCustomer) {
      setCustomer('');
      setEmail('');
    }
  }

  async function record(method: 'cash' | 'link') {
    if (!chosen || !product) return;
    const name = customer.trim();
    if (!name) {
      setError('Enter who this is for.');
      setStep('who');
      return;
    }

    setBusy(true);
    setError(null);

    const backorder = chosen.available <= 0;
    const now = new Date().toISOString();

    // Cash takes the money now; a payment link leaves it owing. The
    // method records what the money did, so a link is 'online' even
    // while the payment is still pending.
    const { data, error: insertError } = await supabase
      .from('orders')
      .insert({
        customer_name: name,
        customer_email: email.trim() || null,
        stock_item_id: chosen.id,
        quantity: 1,
        unit_price: chosen.price,
        payment_status: method === 'cash' ? 'paid' : 'pending',
        payment_method: method === 'cash' ? 'cash' : 'online',
        source: 'manual',
        ordered_at: now,
      })
      .select('id')
      .single();

    if (insertError || !data) {
      setBusy(false);
      setError(insertError?.message ?? 'Could not record the sale.');
      return;
    }

    // Stock only moves on an UPDATE that sets distributed_at — there is
    // no INSERT trigger on orders (see CLAUDE.md). Inserting with
    // distributed_at already set would hand the garment over without
    // ever reducing stock, so the handover must be a second write.
    //
    // A back-order is deliberately NOT handed over: there is nothing in
    // the cupboard to give, so it stays owed and stock stays put.
    let handoverFailed = false;
    if (method === 'cash' && !backorder) {
      const { error: handoverError } = await supabase
        .from('orders')
        .update({
          distributed_at: now,
          handed_over_by: sellerInitials,
          handover_note: 'Sold at the ground',
        })
        .eq('id', data.id);
      handoverFailed = !!handoverError;
    }

    // Email the shop link, but only when there is something to send and
    // somewhere to send it. The order is already saved by this point, so
    // a mail failure is reported and never rolls anything back — losing
    // a sale because SMTP was down would be far worse than a parent
    // having to be sent the link by text.
    const address = email.trim();
    const shouldEmail = method === 'link' && !!address && !!chosen.wix_product_url;
    let emailSent = false;
    let emailReason: string | null = null;

    if (shouldEmail) {
      try {
        const res = await fetch('/api/send-payment-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: data.id }),
        });
        const result = await res.json();
        emailSent = !!result.sent;
        if (!emailSent) emailReason = result.reason ?? result.error ?? 'Sending failed.';
      } catch {
        emailReason = 'No connection while sending.';
      }
    }

    setBusy(false);
    setSale({
      productName: product.name,
      size: chosen.size,
      customerName: name,
      price: chosen.price,
      method,
      backorder,
      paymentUrl: chosen.wix_product_url,
      handoverFailed,
      emailTo: shouldEmail ? address : null,
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

  return (
    <div className="sell">
      {step !== 'done' && (
        <ol className="sell-steps" aria-label="Progress">
          {STEP_LABELS.map(([s, label], i) => (
            <li
              key={s}
              data-state={step === s ? 'now' : stepIndex(step) > i ? 'done' : 'todo'}
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
          <h2 className="sell-h">What are they taking?</h2>
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
          <p className="sell-sub">Which size?</p>
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
                    onClick={() => {
                      setChosen(s);
                      setStep('who');
                    }}
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
          <button className="sell-ghost" onClick={() => reset(true)}>
            &larr; Different item
          </button>
        </section>
      )}

      {step === 'who' && chosen && (
        <section>
          <h2 className="sell-h">Who is it for?</h2>
          <p className="sell-sub">
            {chosen.name} · {chosen.size} · {money(chosen.price)}
          </p>
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

          <button
            className="sell-primary sell-big"
            disabled={!customer.trim()}
            onClick={() => {
              setError(null);
              setStep('pay');
            }}
          >
            Continue
          </button>
          <button className="sell-ghost" onClick={() => setStep('size')}>
            &larr; Different size
          </button>
        </section>
      )}

      {step === 'pay' && chosen && (
        <section>
          <h2 className="sell-h">How are they paying?</h2>
          <p className="sell-sub">
            {chosen.name} · {chosen.size} · {money(chosen.price)} · {customer.trim()}
          </p>
          {chosen.available <= 0 && (
            <p className="sell-warn">
              None in stock. This is recorded as owed, and nothing is handed
              over today.
            </p>
          )}
          <button
            className="sell-primary sell-big"
            disabled={busy}
            onClick={() => record('cash')}
          >
            {busy ? 'Saving…' : `Paid — cash ${money(chosen.price)}`}
          </button>
          <button
            className="sell-secondary sell-big"
            disabled={busy}
            onClick={() => record('link')}
          >
            {busy ? 'Saving…' : 'Send payment link'}
          </button>
          <button className="sell-ghost" onClick={() => setStep('who')}>
            &larr; Back
          </button>
        </section>
      )}

      {step === 'done' && sale && (
        <section>
          <div
            className="sell-done"
            data-owed={sale.backorder || sale.method === 'link'}
          >
            <span className="sell-done-badge">
              {sale.backorder
                ? 'OWED — not handed over'
                : sale.method === 'cash'
                  ? 'Handed over'
                  : 'Awaiting payment'}
            </span>
            <h2 className="sell-done-title">
              {sale.productName} · {sale.size}
            </h2>
            <p className="sell-done-who">for {sale.customerName}</p>
            <p className="sell-done-detail">
              {sale.method === 'cash'
                ? `Cash ${money(sale.price)} taken`
                : `${money(sale.price)} to pay online`}
            </p>

            {sale.backorder && (
              <p className="sell-done-warn">
                Nothing was handed over. {sale.customerName} is still owed one{' '}
                {sale.productName} in {sale.size}. It shows in Orders as waiting
                on stock.
              </p>
            )}

            {sale.handoverFailed && (
              <p className="sell-done-warn">
                The sale was recorded, but marking it handed over failed. Open
                Orders and hand it over there, or stock will be wrong.
              </p>
            )}

            {sale.emailTo && sale.emailSent && (
              <p className="sell-done-sent">Payment link emailed to {sale.emailTo}</p>
            )}

            {sale.emailTo && !sale.emailSent && (
              <p className="sell-done-warn">
                The order is saved, but the email did not send
                {sale.emailReason ? ` (${sale.emailReason})` : ''}. Copy the link
                below and text it to them instead.
              </p>
            )}
          </div>

          {sale.method === 'link' &&
            (sale.paymentUrl ? (
              <div className="sell-link">
                <a
                  href={sale.paymentUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="sell-link-url"
                >
                  {sale.paymentUrl}
                </a>
                <button
                  className="sell-secondary sell-big"
                  onClick={() => copyLink(sale.paymentUrl as string)}
                >
                  {copied ? 'Copied' : 'Copy link'}
                </button>
              </div>
            ) : (
              <p className="sell-note">
                This item has no shop page recorded, so there is no link to
                send. Run the Wix media sync, or take payment another way.
              </p>
            ))}

          <button className="sell-primary sell-big" onClick={() => reset(true)}>
            Sell another to {sale.customerName}
          </button>
          <button className="sell-ghost" onClick={() => reset(false)}>
            Done — new customer
          </button>
        </section>
      )}
    </div>
  );
}
