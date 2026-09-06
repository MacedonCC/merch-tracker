'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase-client';
import type { MemberPermissions } from '@/lib/member';

// A small "..." menu for a row's secondary actions — Remove today,
// anything else later — kept separate from the one visible primary
// action per row (Mark paid / Hand over / Undo).
function RowMenu({ actions }: { actions: { label: string; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  if (actions.length === 0) return null;

  return (
    <div className="row-menu-wrap" ref={ref}>
      <button
        type="button"
        className="row-menu-btn"
        aria-label="More actions"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open && (
        <div className="row-menu" role="menu">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              className="row-menu-item"
              onClick={() => { setOpen(false); a.onClick(); }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export type Section = 'stock' | 'restock' | 'orders';

const CATEGORIES = ['T-Shirt', 'Hoodie', 'Cap', 'Jacket', 'Shorts', 'Other'];
const SIZES = ['JNR8', 'JNR10', 'JNR12', 'JNR14', 'JNR16', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', 'Small', 'Medium', 'Large', 'One size'];

interface StockRow {
  id: string;
  name: string;
  category: string;
  size: string;
  price: number;
  on_hand: number;
  low_stock_alert: number;
  target_level: number;
  committed: number;
  available: number;
  suggested_order: number;
  shortfall: number;
  stock_status: 'ok' | 'low' | 'out' | 'oversold';
  wix_product_id: string | null;
}

interface OrderRow {
  id: string;
  reference: string;
  customer_name: string;
  customer_email: string | null;
  stock_item_id: string | null;
  quantity: number;
  unit_price: number;
  payment_status: 'pending' | 'paid' | 'refunded';
  distributed_at: string | null;
  handed_over_by: string | null;
  handover_note: string | null;
  source: 'manual' | 'wix';
  ordered_at: string;
  notes: string | null;
  stock_items?: { name: string; size: string } | null;
}

const money = (n: number) =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n);

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-AU');

// Each order has two independent facts — paid or not, handed over or
// not — but the four things a helper actually cares about collapse
// those into one state: an unpaid order is "unpaid" regardless of
// stock; a paid, handed-over order is "done" regardless of how it got
// there (including the unreachable-via-this-UI 'refunded' status,
// which falls back to "unpaid" here since nothing in the app ever sets
// it and it doesn't fit any of the four named buckets).
type OrderState = 'unpaid' | 'ready' | 'waiting' | 'done';

function classifyOrder(o: OrderRow, byId: Map<string, StockRow>): OrderState {
  if (o.distributed_at) return 'done';
  if (o.payment_status === 'paid') {
    const s = o.stock_item_id ? byId.get(o.stock_item_id) : null;
    const onHand = s ? s.on_hand : 0;
    return onHand >= o.quantity ? 'ready' : 'waiting';
  }
  return 'unpaid';
}

const CHIPS: { key: 'all' | OrderState; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unpaid', label: 'Unpaid' },
  { key: 'ready', label: 'Ready' },
  { key: 'waiting', label: 'Waiting on stock' },
  { key: 'done', label: 'Done' },
];

interface OrderGroup {
  key: string;
  name: string;
  email: string | null;
  items: OrderRow[];
}

// Groups ready-to-hand-over orders by customer so one visit collects
// everything they're owed. A group of one renders identically to a
// plain row (see the Ready view below) — this only changes how many
// item lines and whether the button says "all".
function groupByCustomer(orders: OrderRow[]): OrderGroup[] {
  const map = new Map<string, OrderGroup>();
  for (const o of orders) {
    const key = `${o.customer_name.trim().toLowerCase()}|${(o.customer_email ?? '').trim().toLowerCase()}`;
    const existing = map.get(key);
    if (existing) existing.items.push(o);
    else map.set(key, { key, name: o.customer_name, email: o.customer_email, items: [o] });
  }
  return Array.from(map.values());
}

export default function TrackerSection({
  section,
  userEmail,
  role,
  permissions,
}: {
  section: Section;
  userEmail: string;
  role: 'admin' | 'helper';
  permissions: MemberPermissions;
}) {
  const isAdmin = role === 'admin';
  const canEditStock = permissions.can_adjust_stock || permissions.can_change_prices || permissions.can_change_targets;
  const supabase = useMemo(() => createClient(), []);
  const [stock, setStock] = useState<StockRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<'item' | 'order' | 'edit' | 'handover' | null>(null);
  const [editing, setEditing] = useState<StockRow | null>(null);
  const [handoverForm, setHandoverForm] = useState<{ ids: string[]; date: string; initials: string; note: string } | null>(null);
  const [message, setMessage] = useState('');

  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('');
  const [level, setLevel] = useState('');
  const [orderSearch, setOrderSearch] = useState('');
  const [orderChip, setOrderChip] = useState<'all' | OrderState>('ready');

  async function load() {
    const [{ data: s }, { data: o }] = await Promise.all([
      supabase.from('stock_overview').select('*').order('name').order('size'),
      supabase
        .from('orders')
        .select('*, stock_items(name, size)')
        .order('ordered_at', { ascending: false }),
    ]);
    setStock((s as StockRow[]) ?? []);
    setOrders((o as OrderRow[]) ?? []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function flash(t: string) {
    setMessage(t);
    setTimeout(() => setMessage(''), 4000);
  }

  // ---- Actions -------------------------------------------------------
  async function addItem(form: HTMLFormElement) {
    const f = new FormData(form);
    const name = String(f.get('name') ?? '').trim();
    if (!name) return flash('Item name is required.');

    const { error } = await supabase.from('stock_items').insert({
      name,
      category: String(f.get('category')),
      size: String(f.get('size')),
      price: Number(f.get('price')) || 0,
      quantity: Number(f.get('quantity')) || 0,
      low_stock_alert: Number(f.get('alert')) || 3,
      target_level: Number(f.get('target')) || 0,
    });
    if (error) return flash(error.message);
    setModal(null);
    flash('Item added.');
    load();
  }

  async function saveItem(form: HTMLFormElement) {
    if (!editing) return;
    const f = new FormData(form);
    // Read a field's new value only if the viewer is actually allowed to
    // change it — a disabled input is excluded from FormData anyway, but
    // this also stops a re-enabled field (e.g. via devtools) from being
    // sent as a change; the RLS trigger enforces this again server-side.
    const newQty = permissions.can_adjust_stock ? Number(f.get('quantity')) || 0 : editing.on_hand;
    const newPrice = permissions.can_change_prices ? Number(f.get('price')) || 0 : editing.price;
    const newAlert = permissions.can_change_targets ? Number(f.get('alert')) || 0 : editing.low_stock_alert;
    const newTarget = permissions.can_change_targets ? Number(f.get('target')) || 0 : editing.target_level;
    const diff = newQty - editing.on_hand;

    const { error } = await supabase
      .from('stock_items')
      .update({
        quantity: newQty,
        price: newPrice,
        low_stock_alert: newAlert,
        target_level: newTarget,
        updated_at: new Date().toISOString(),
      })
      .eq('id', editing.id);

    if (error) return flash(error.message);

    if (diff !== 0) {
      await supabase.from('stock_movements').insert({
        stock_item_id: editing.id,
        change: diff,
        reason: 'Counted by hand',
        created_by: userEmail,
      });
    }
    setModal(null);
    setEditing(null);
    flash('Stock updated.');
    load();
  }

  async function addOrder(form: HTMLFormElement) {
    const f = new FormData(form);
    const name = String(f.get('customer') ?? '').trim();
    if (!name) return flash('Customer name is required.');

    const itemId = String(f.get('item'));
    const item = stock.find((i) => i.id === itemId);

    const { error } = await supabase.from('orders').insert({
      customer_name: name,
      customer_email: String(f.get('email') ?? '').trim() || null,
      stock_item_id: itemId || null,
      quantity: Number(f.get('quantity')) || 1,
      unit_price: item?.price ?? 0,
      payment_status: String(f.get('status')),
      ordered_at: String(f.get('date') || new Date().toISOString().slice(0, 10)),
      source: 'manual',
    });
    if (error) return flash(error.message);
    setModal(null);
    flash('Order recorded.');
    load();
  }

  async function markPaid(id: string) {
    await supabase.from('orders').update({ payment_status: 'paid' }).eq('id', id);
    flash('Marked as paid.');
    load();
  }

  // Opens the handover modal rather than writing straight away — for a
  // fresh handover (no `existing`) it defaults to today and whatever
  // initials were last used this session; for "Edit handover" on an
  // already-done order it pre-fills from that order's own values so a
  // mistake can be corrected without an undo/redo round trip.
  function openHandoverModal(ids: string[], existing?: OrderRow) {
    const today = new Date().toISOString().slice(0, 10);
    let remembered = '';
    try { remembered = sessionStorage.getItem('handoverInitials') ?? ''; } catch {}

    setHandoverForm({
      ids,
      date: existing?.distributed_at ? existing.distributed_at.slice(0, 10) : today,
      initials: existing?.handed_over_by ?? remembered,
      note: existing?.handover_note ?? '',
    });
    setModal('handover');
  }

  async function saveHandover(form: HTMLFormElement) {
    if (!handoverForm) return;
    const f = new FormData(form);
    const date = String(f.get('date') ?? '').trim();
    const initials = String(f.get('initials') ?? '').trim();
    const note = String(f.get('note') ?? '').trim() || null;
    if (!date) return flash('Date is required.');
    if (!initials) return flash('Initials are required.');

    try { sessionStorage.setItem('handoverInitials', initials); } catch {}

    const { error } = await supabase
      .from('orders')
      .update({
        // Noon rather than midnight so the chosen calendar date can't
        // shift a day either way once toLocaleDateString re-renders it
        // in the viewer's own timezone.
        distributed_at: new Date(`${date}T12:00:00`).toISOString(),
        handed_over_by: initials,
        handover_note: note,
      })
      .in('id', handoverForm.ids);
    if (error) return flash(error.message);
    setModal(null);
    setHandoverForm(null);
    flash(handoverForm.ids.length > 1 ? `Handed over ${handoverForm.ids.length} items.` : 'Handed over.');
    load();
  }

  async function undoHandover(id: string) {
    const { error } = await supabase
      .from('orders')
      .update({ distributed_at: null, handed_over_by: null, handover_note: null })
      .eq('id', id);
    if (error) return flash(error.message);
    flash('Handover reversed.');
    load();
  }

  async function removeOrder(id: string) {
    if (!confirm('Remove this order?')) return;
    const { error } = await supabase.from('orders').delete().eq('id', id);
    if (error) return flash(error.message);
    flash('Order removed.');
    load();
  }

  // ---- Derived -------------------------------------------------------
  const byId = new Map(stock.map((s) => [s.id, s]));

  const restock = stock
    .filter((s) => s.suggested_order > 0)
    .sort((a, b) => b.shortfall - a.shortfall || b.suggested_order - a.suggested_order);

  const totalOnHand = stock.reduce((n, s) => n + s.on_hand, 0);
  const totalCommitted = stock.reduce((n, s) => n + s.committed, 0);
  const totalShort = stock.reduce((n, s) => n + s.shortfall, 0);
  const toOrder = restock.reduce((n, s) => n + s.suggested_order, 0);
  const owed = orders
    .filter((o) => o.payment_status === 'pending')
    .reduce((n, o) => n + o.unit_price * o.quantity, 0);

  const visibleStock = stock.filter((s) => {
    const q = search.toLowerCase();
    return (
      (!q || s.name.toLowerCase().includes(q)) &&
      (!cat || s.category === cat) &&
      (!level || s.stock_status === level)
    );
  });

  const classifiedOrders = orders.map((o) => ({ order: o, state: classifyOrder(o, byId) }));

  const orderCounts = {
    all: classifiedOrders.length,
    unpaid: classifiedOrders.filter((c) => c.state === 'unpaid').length,
    ready: classifiedOrders.filter((c) => c.state === 'ready').length,
    waiting: classifiedOrders.filter((c) => c.state === 'waiting').length,
    done: classifiedOrders.filter((c) => c.state === 'done').length,
  };

  const searchedOrders = classifiedOrders.filter(({ order: o }) => {
    const q = orderSearch.trim().toLowerCase();
    if (!q) return true;
    return o.customer_name.toLowerCase().includes(q) || (o.customer_email ?? '').toLowerCase().includes(q);
  });

  const visibleOrders = orderChip === 'all' ? searchedOrders : searchedOrders.filter((c) => c.state === orderChip);

  const readyGroups = groupByCustomer(searchedOrders.filter((c) => c.state === 'ready').map((c) => c.order));

  if (loading)
    return <p style={{ color: 'var(--ink-soft)' }}>Loading…</p>;

  const pill = (s: StockRow) => {
    if (s.stock_status === 'oversold') return <span className="pill pill-out">Oversold</span>;
    if (s.stock_status === 'out') return <span className="pill pill-out">None left</span>;
    if (s.stock_status === 'low') return <span className="pill pill-low">Low</span>;
    return <span className="pill pill-ok">In stock</span>;
  };

  return (
    <>
      {message && <div className="note note-ok" style={{ marginBottom: '1rem' }}>{message}</div>}

      <div className="metrics">
        <div className="metric">
          <span>On hand</span><strong>{totalOnHand}</strong>
          <small>garments in the cupboard</small>
        </div>
        <div className="metric">
          <span>Owed to people</span><strong>{totalCommitted}</strong>
          <small>paid, not handed over</small>
        </div>
        <div className="metric">
          <span>Short</span>
          <strong style={{ color: totalShort ? 'var(--alert)' : undefined }}>{totalShort}</strong>
          <small>owed with nothing to give</small>
        </div>
        <div className="metric">
          <span>To order</span><strong>{toOrder}</strong>
          <small>{money(owed)} still unpaid</small>
        </div>
      </div>

      {/* ---------------- Stock ---------------- */}
      {section === 'stock' && (
        <div className="card">
          <div className="card-head">
            <h2>Inventory</h2>
            {isAdmin && <button className="btn-solid" onClick={() => setModal('item')}>Add item</button>}
          </div>
          <div className="filters">
            <input placeholder="Search items" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">All categories</option>
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
            <select value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="">All levels</option>
              <option value="ok">In stock</option>
              <option value="low">Low</option>
              <option value="out">None left</option>
              <option value="oversold">Oversold</option>
            </select>
          </div>
          <table>
            <thead>
              <tr>
                <th>Item</th><th>Size</th><th>Price</th>
                <th>On hand</th><th>Owed</th><th>Available</th>
                <th>Target</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {visibleStock.length === 0 ? (
                <tr><td colSpan={9}><div className="empty">Nothing matches those filters.</div></td></tr>
              ) : visibleStock.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong style={{ fontWeight: 500 }}>{s.name}</strong>
                    <div style={{ fontSize: '0.75rem', color: 'var(--ink-faint)' }}>{s.category}</div>
                  </td>
                  <td>{s.size}</td>
                  <td>{money(s.price)}</td>
                  <td>{s.on_hand}</td>
                  <td>{s.committed || '—'}</td>
                  <td style={{ color: s.available < 0 ? 'var(--alert)' : undefined, fontWeight: 500 }}>
                    {s.available}
                  </td>
                  <td>{s.target_level}</td>
                  <td>{pill(s)}</td>
                  <td>{canEditStock && <button className="btn-mini" onClick={() => { setEditing(s); setModal('edit'); }}>Edit</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------------- Restock ---------------- */}
      {section === 'restock' && (
        <div className="card">
          <div className="card-head">
            <h2>What to order</h2>
            <button onClick={() => {
              const lines = restock.map((s) => `${s.suggested_order} x ${s.name} — ${s.size}`).join('\n');
              navigator.clipboard.writeText(lines);
              flash('Order list copied.');
            }}>Copy list</button>
          </div>
          <table>
            <thead>
              <tr><th>Item</th><th>Size</th><th>On hand</th><th>Owed</th><th>Short</th><th>Target</th><th>Order</th></tr>
            </thead>
            <tbody>
              {restock.length === 0 ? (
                <tr><td colSpan={7}><div className="empty">Nothing to order. Every size is at or above its target.</div></td></tr>
              ) : restock.map((s) => (
                <tr key={s.id}>
                  <td><strong style={{ fontWeight: 500 }}>{s.name}</strong></td>
                  <td>{s.size}</td>
                  <td>{s.on_hand}</td>
                  <td>{s.committed || '—'}</td>
                  <td>{s.shortfall > 0 ? <span className="pill pill-out">{s.shortfall}</span> : '—'}</td>
                  <td>{s.target_level}</td>
                  <td style={{ fontWeight: 500, fontSize: '1rem' }}>{s.suggested_order}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------------- Orders ---------------- */}
      {section === 'orders' && (
        <div className="card">
          <div className="card-head">
            <h2>Orders</h2>
            <button className="btn-solid" onClick={() => setModal('order')}>Add order</button>
          </div>

          <div className="chip-row">
            {CHIPS.map((c) => (
              <button
                key={c.key}
                type="button"
                className="chip"
                data-active={orderChip === c.key}
                onClick={() => setOrderChip(c.key)}
              >
                {c.label} <span className="chip-count">{orderCounts[c.key]}</span>
              </button>
            ))}
          </div>

          <div className="filters">
            <input placeholder="Search by name or email" value={orderSearch} onChange={(e) => setOrderSearch(e.target.value)} />
          </div>

          {orderChip === 'ready' ? (
            <div className="order-groups">
              {readyGroups.length === 0 ? (
                <div className="empty">Nothing ready to hand over.</div>
              ) : readyGroups.map((g) => (
                <div className="order-group" key={g.key}>
                  <div className="order-group-who">
                    <strong>{g.name}</strong>
                    <div>{g.email ?? '—'}</div>
                  </div>
                  <div className="order-group-items">
                    {g.items.map((i) => (
                      <div key={i.id} className="order-group-item">
                        <span>
                          {i.quantity} × {i.stock_items ? `${i.stock_items.name} · ${i.stock_items.size}` : '—'}
                          <span style={{ color: 'var(--ink-faint)', fontSize: '0.75rem', marginLeft: 8 }}>{formatDate(i.ordered_at)}</span>
                        </span>
                        <RowMenu
                          actions={[
                            { label: 'Hand over', onClick: () => openHandoverModal([i.id]) },
                            ...(isAdmin ? [{ label: 'Remove', onClick: () => removeOrder(i.id) }] : []),
                          ]}
                        />
                      </div>
                    ))}
                  </div>
                  <button className="btn-mini" onClick={() => openHandoverModal(g.items.map((i) => i.id))}>
                    {g.items.length > 1 ? 'Hand over all' : 'Hand over'}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <table>
              <thead>
                <tr><th>Who</th><th>Item</th><th>Qty</th><th>Ordered</th><th>Status</th><th></th><th></th></tr>
              </thead>
              <tbody>
                {visibleOrders.length === 0 ? (
                  <tr><td colSpan={7}><div className="empty">No orders match.</div></td></tr>
                ) : visibleOrders.map(({ order: o, state }) => (
                  <tr key={o.id}>
                    <td>
                      <strong style={{ fontWeight: 500 }}>{o.customer_name}</strong>
                      <div style={{ fontSize: '0.75rem', color: 'var(--ink-faint)' }}>{o.customer_email ?? o.reference}</div>
                    </td>
                    <td>{o.stock_items ? `${o.stock_items.name} · ${o.stock_items.size}` : '—'}</td>
                    <td>{o.quantity}</td>
                    <td style={{ fontSize: '0.85rem' }}>{formatDate(o.ordered_at)}</td>
                    <td>
                      {state === 'unpaid' && <span className="pill pill-out">Unpaid</span>}
                      {state === 'ready' && <span className="pill pill-ok">Ready</span>}
                      {state === 'waiting' && <span className="pill pill-low">Waiting on stock</span>}
                      {state === 'done' && (
                        <>
                          <span className="pill pill-grey">Done</span>
                          <div style={{ fontSize: '0.75rem', color: 'var(--ink-faint)', marginTop: 4 }}>
                            {o.handed_over_by && <>by {o.handed_over_by} </>}
                            {o.distributed_at && <>· {formatDate(o.distributed_at)}</>}
                          </div>
                          {o.handover_note && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--ink-faint)', fontStyle: 'italic', marginTop: 2 }}>
                              “{o.handover_note}”
                            </div>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      {state === 'unpaid' && (
                        <button className="btn-mini" onClick={() => markPaid(o.id)}>Mark paid</button>
                      )}
                      {state === 'ready' && (
                        <button className="btn-mini" onClick={() => openHandoverModal([o.id])}>Hand over</button>
                      )}
                      {state === 'waiting' && (
                        <span style={{ fontSize: '0.78rem', color: 'var(--ink-faint)' }}>
                          {(o.stock_item_id ? byId.get(o.stock_item_id)?.on_hand : 0) ?? 0} in stock
                        </span>
                      )}
                      {state === 'done' && permissions.can_undo_handover && (
                        <button className="btn-mini btn-quiet" onClick={() => undoHandover(o.id)}>Undo</button>
                      )}
                    </td>
                    <td>
                      <RowMenu
                        actions={[
                          ...(state === 'done' ? [{ label: 'Edit handover', onClick: () => openHandoverModal([o.id], o) }] : []),
                          ...(isAdmin ? [{ label: 'Remove', onClick: () => removeOrder(o.id) }] : []),
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ---------------- Modals ---------------- */}
      {modal === 'item' && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setModal(null)}>
          <form className="modal" onSubmit={(e) => { e.preventDefault(); addItem(e.currentTarget); }}>
            <h3>Add stock item</h3>
            <div className="field"><label>Item name</label><input name="name" autoFocus /></div>
            <div className="field-pair">
              <div className="field"><label>Category</label>
                <select name="category">{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></div>
              <div className="field"><label>Size</label>
                <select name="size">{SIZES.map((s) => <option key={s}>{s}</option>)}</select></div>
            </div>
            <div className="field-pair">
              <div className="field"><label>Price (AUD)</label><input name="price" type="number" step="0.01" min="0" defaultValue="0" onWheel={(e) => e.currentTarget.blur()} /></div>
              <div className="field"><label>On hand now</label><input name="quantity" type="number" min="0" defaultValue="0" onWheel={(e) => e.currentTarget.blur()} /></div>
            </div>
            <div className="field-pair">
              <div className="field"><label>Warn when available drops to</label><input name="alert" type="number" min="0" defaultValue="3" onWheel={(e) => e.currentTarget.blur()} /></div>
              <div className="field"><label>Target to hold</label><input name="target" type="number" min="0" defaultValue="5" onWheel={(e) => e.currentTarget.blur()} /></div>
            </div>
            <div className="modal-actions">
              <button type="button" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="btn-solid">Add item</button>
            </div>
          </form>
        </div>
      )}

      {modal === 'edit' && editing && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setModal(null)}>
          <form className="modal" onSubmit={(e) => { e.preventDefault(); saveItem(e.currentTarget); }}>
            <h3>{editing.name} · {editing.size}</h3>
            <p style={{ fontSize: '0.82rem', color: 'var(--ink-soft)', marginBottom: '1rem' }}>
              {editing.committed} owed to people. Available: {editing.available}.
            </p>
            <div className="field"><label>On hand (physical count)</label>
              <input name="quantity" type="number" min="0" defaultValue={editing.on_hand} autoFocus disabled={!permissions.can_adjust_stock} onWheel={(e) => e.currentTarget.blur()} /></div>
            <div className="field"><label>Price (AUD)</label>
              <input name="price" type="number" step="0.01" min="0" defaultValue={editing.price} disabled={!permissions.can_change_prices} onWheel={(e) => e.currentTarget.blur()} /></div>
            <div className="field-pair">
              <div className="field"><label>Warn when available drops to</label>
                <input name="alert" type="number" min="0" defaultValue={editing.low_stock_alert} disabled={!permissions.can_change_targets} onWheel={(e) => e.currentTarget.blur()} /></div>
              <div className="field"><label>Target to hold</label>
                <input name="target" type="number" min="0" defaultValue={editing.target_level} disabled={!permissions.can_change_targets} onWheel={(e) => e.currentTarget.blur()} /></div>
            </div>
            <div className="modal-actions">
              <button type="button" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="btn-solid">Save</button>
            </div>
          </form>
        </div>
      )}

      {modal === 'handover' && handoverForm && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setModal(null)}>
          <form className="modal" onSubmit={(e) => { e.preventDefault(); saveHandover(e.currentTarget); }}>
            <h3>{handoverForm.ids.length > 1 ? `Hand over ${handoverForm.ids.length} items` : 'Hand over'}</h3>
            <div className="field"><label>Date handed over</label>
              <input name="date" type="date" defaultValue={handoverForm.date} autoFocus /></div>
            <div className="field"><label>Initials</label>
              <input name="initials" defaultValue={handoverForm.initials} placeholder="e.g. AB" required /></div>
            <div className="field"><label>Comments (optional)</label>
              <textarea name="note" rows={3} defaultValue={handoverForm.note}></textarea></div>
            <div className="modal-actions">
              <button type="button" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="btn-solid">Confirm</button>
            </div>
          </form>
        </div>
      )}

      {modal === 'order' && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setModal(null)}>
          <form className="modal" onSubmit={(e) => { e.preventDefault(); addOrder(e.currentTarget); }}>
            <h3>Record an order</h3>
            <div className="field"><label>Customer name</label><input name="customer" autoFocus /></div>
            <div className="field"><label>Email (optional)</label><input name="email" type="email" /></div>
            <div className="field"><label>Item</label>
              <select name="item">
                {stock.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} · {i.size} ({i.available} available)
                  </option>
                ))}
              </select>
            </div>
            <div className="field-pair">
              <div className="field"><label>Quantity</label><input name="quantity" type="number" min="1" defaultValue="1" onWheel={(e) => e.currentTarget.blur()} /></div>
              <div className="field"><label>Payment</label>
                <select name="status"><option value="pending">Not paid yet</option><option value="paid">Paid</option></select></div>
            </div>
            <div className="field"><label>Date ordered</label>
              <input name="date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} /></div>
            <div className="modal-actions">
              <button type="button" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="btn-solid">Record order</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
