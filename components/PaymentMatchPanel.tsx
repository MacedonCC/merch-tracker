'use client';

import { useState } from 'react';
import type { ReviewOrder, ReviewPair } from '@/lib/payment-link-review';

// The Admin page's "Payment-link matches" card: /sell payment-link
// orders and Wix payments that may be the same sale but were not merged
// automatically (see lib/payment-link-match.ts for the rule). Approve
// merges the pair through merge_payment_link_order(); Dismiss records
// that they are different sales so the pair stops being listed.

const KIND_LABEL: Record<ReviewPair['kind'], { text: string; pill: string }> = {
  auto: { text: 'Clear match', pill: 'pill-ok' },
  confirm: { text: 'Needs confirming', pill: 'pill-low' },
  'near-miss': { text: 'Near-miss', pill: 'pill-grey' },
};

function when(iso: string): string {
  return new Date(iso).toLocaleDateString('en-AU', {
    day: 'numeric', month: 'short', timeZone: 'Australia/Melbourne',
  });
}

function OrderSide({ title, o }: { title: string; o: ReviewOrder }) {
  return (
    <div className="match-side">
      <div className="match-side-title">{title}</div>
      <div><strong>{o.name}</strong> · {o.reference}{o.wixOrderNumber ? ` · Wix #${o.wixOrderNumber}` : ''}</div>
      <div>{o.item} × {o.quantity}</div>
      <div className="match-muted">{o.email ?? 'No email'}</div>
      <div className="match-muted">{when(o.orderedAt)} · {o.handedOver ? 'Handed over' : 'Not handed over'}</div>
    </div>
  );
}

export default function PaymentMatchPanel({
  initialPairs,
  autoMatching,
}: {
  initialPairs: ReviewPair[];
  autoMatching: boolean;
}) {
  const [pairs, setPairs] = useState(initialPairs);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const keyOf = (p: ReviewPair) => `${p.manual.orderId}::${p.wix.orderId}`;

  async function act(p: ReviewPair, action: 'approve' | 'dismiss') {
    const prompt = action === 'approve'
      ? `Merge ${p.wix.name}'s Wix payment into ${p.manual.name}'s order ${p.manual.reference}?\n\n` +
        `${p.manual.reference} becomes paid and keeps its name, email and handover state. ` +
        `The separate Wix order row is removed. Stock does not change.`
      : `Mark these as different sales? The pair will stop being listed. Both orders stay as they are.`;
    if (!window.confirm(prompt)) return;

    setBusy(keyOf(p));
    setMessage(null);
    try {
      const res = await fetch('/api/payment-link-match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, manualId: p.manual.orderId, wixRowId: p.wix.orderId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? 'That did not work.' });
        return;
      }
      // Either order may appear in other pairs; once one is merged those
      // pairs are void, so drop every pair that shares an order.
      setPairs((all) => all.filter((q) =>
        action === 'dismiss'
          ? keyOf(q) !== keyOf(p)
          : q.manual.orderId !== p.manual.orderId && q.wix.orderId !== p.wix.orderId,
      ));
      setMessage({
        ok: true,
        text: action === 'approve' ? `Merged. ${p.manual.reference} is now paid.` : 'Dismissed.',
      });
    } catch {
      setMessage({ ok: false, text: 'No connection.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card" style={{ marginBottom: '1.25rem' }}>
      <div className="card-head">
        <h2>Payment-link matches</h2>
        <span className={`pill ${autoMatching ? 'pill-ok' : 'pill-grey'}`}>
          Automatic matching {autoMatching ? 'on' : 'off'}
        </span>
      </div>
      <div style={{ padding: '0.9rem 1.15rem' }}>
        <p className="match-muted" style={{ marginTop: 0 }}>
          /sell orders paid by payment link that might be the same sale as a Wix payment, but
          weren&rsquo;t merged automatically.
        </p>
        {message && (
          <div className={`note ${message.ok ? 'note-ok' : 'note-bad'}`} style={{ marginBottom: '0.75rem' }}>
            {message.text}
          </div>
        )}
        {pairs.length === 0 ? (
          <div className="empty">Nothing to check.</div>
        ) : (
          pairs.map((p) => {
            const k = keyOf(p);
            const label = KIND_LABEL[p.kind];
            return (
              <div key={k} className="match-pair">
                <div className="match-pair-head">
                  <span className={`pill ${label.pill}`}>{label.text}</span>
                  <span className="match-muted">{p.reasons.join(' · ')}</span>
                </div>
                <div className="match-sides">
                  <OrderSide title="/sell order" o={p.manual} />
                  <OrderSide title="Wix payment" o={p.wix} />
                </div>
                {p.blocked && <p className="match-muted" style={{ margin: '0.5rem 0 0' }}>{p.blocked}</p>}
                <div className="match-actions">
                  {!p.blocked && (
                    <button className="btn-mini" disabled={busy !== null} onClick={() => act(p, 'approve')}>
                      {busy === k ? 'Working…' : 'Approve merge'}
                    </button>
                  )}
                  <button className="btn-mini" disabled={busy !== null} onClick={() => act(p, 'dismiss')}>
                    Different sales
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
