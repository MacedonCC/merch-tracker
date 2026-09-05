'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-client';

export type Section = 'stock' | 'handovers' | 'restock' | 'orders';

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
  source: 'manual' | 'wix';
  ordered_at: string;
  notes: string | null;
  stock_items?: { name: string; size: string } | null;
}

const money = (n: number) =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n);

export default function TrackerSection({
  section,
  userEmail,
  role,
}: {
  section: Section;
  userEmail: string;
  role: 'admin' | 'helper';
}) {
  const isAdmin = role === 'admin';
  const supabase = useMemo(() => createClient(), []);
  const [stock, setStock] = useState<StockRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<'item' | 'order' | 'edit' | null>(null);
  const [editing, setEditing] = useState<StockRow | null>(null);
  const [message, setMessage] = useState('');

  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('');
  const [level, setLevel] = useState('');
  const [orderSearch, setOrderSearch] = useState('');
  const [orderFilter, setOrderFilter] = useState('');

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
    const newQty = Number(f.get('quantity')) || 0;
    const diff = newQty - editing.on_hand;

    const { error } = await supabase
      .from('stock_items')
      .update({
        quantity: newQty,
        price: Number(f.get('price')) || 0,
        low_stock_alert: Number(f.get('alert')) || 0,
        target_level: Number(f.get('target')) || 0,
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

  async function setTarget(id: string, value: number) {
    await supabase.from('stock_items').update({ target_level: Math.max(0, value) }).eq('id', id);
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

  async function handOver(id: string) {
    await supabase
      .from('orders')
      .update({ distributed_at: new Date().toISOString() })
      .eq('id', id);
    flash('Handed over. Stock reduced.');
    load();
  }

  async function undoHandover(id: string) {
    await supabase.from('orders').update({ distributed_at: null }).eq('id', id);
    flash('Handover reversed. Stock returned.');
    load();
  }

  async function removeOrder(id: string) {
    if (!confirm('Remove this order?')) return;
    await supabase.from('orders').delete().eq('id', id);
    flash('Order removed.');
    load();
  }

  // ---- Derived -------------------------------------------------------
  const byId = new Map(stock.map((s) => [s.id, s]));

  const readyToHandOver = orders.filter((o) => {
    if (o.payment_status !== 'paid' || o.distributed_at) return false;
    const s = o.stock_item_id ? byId.get(o.stock_item_id) : null;
    return s ? s.on_hand >= o.quantity : false;
  });

  const waitingOnStock = orders.filter((o) => {
    if (o.payment_status !== 'paid' || o.distributed_at) return false;
    const s = o.stock_item_id ? byId.get(o.stock_item_id) : null;
    return s ? s.on_hand < o.quantity : true;
  });

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

  const visibleOrders = orders.filter((o) => {
    const q = orderSearch.toLowerCase();
    const label = `${o.customer_name} ${o.stock_items?.name ?? ''}`.toLowerCase();
    const state = o.distributed_at ? 'distributed' : o.payment_status;
    return (!q || label.includes(q)) && (!orderFilter || state === orderFilter);
  });

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
                  <td>
                    <input
                      type="number"
                      min="0"
                      defaultValue={s.target_level}
                      disabled={!isAdmin}
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (v !== s.target_level) setTarget(s.id, v);
                      }}
                      style={{ width: 62, padding: '3px 6px', fontSize: '0.8rem' }}
                    />
                  </td>
                  <td>{pill(s)}</td>
                  <td>{isAdmin && <button className="btn-mini" onClick={() => { setEditing(s); setModal('edit'); }}>Count</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------------- Handovers ---------------- */}
      {section === 'handovers' && (
        <>
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <div className="card-head"><h2>Ready to hand over</h2></div>
            <table>
              <thead><tr><th>Who</th><th>Item</th><th>Qty</th><th>Ordered</th><th></th></tr></thead>
              <tbody>
                {readyToHandOver.length === 0 ? (
                  <tr><td colSpan={5}><div className="empty">Nothing waiting. Everything paid for has been handed over.</div></td></tr>
                ) : readyToHandOver.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <strong style={{ fontWeight: 500 }}>{o.customer_name}</strong>
                      <div style={{ fontSize: '0.75rem', color: 'var(--ink-faint)' }}>{o.customer_email ?? o.reference}</div>
                    </td>
                    <td>{o.stock_items ? `${o.stock_items.name} · ${o.stock_items.size}` : '—'}</td>
                    <td>{o.quantity}</td>
                    <td style={{ fontSize: '0.8rem' }}>{new Date(o.ordered_at).toLocaleDateString('en-AU')}</td>
                    <td><button className="btn-mini" onClick={() => handOver(o.id)}>Hand over</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <div className="card-head"><h2>Waiting on stock</h2></div>
            <table>
              <thead><tr><th>Who</th><th>Item</th><th>Qty</th><th>On hand</th><th>Ordered</th></tr></thead>
              <tbody>
                {waitingOnStock.length === 0 ? (
                  <tr><td colSpan={5}><div className="empty">Nobody is waiting on stock.</div></td></tr>
                ) : waitingOnStock.map((o) => {
                  const s = o.stock_item_id ? byId.get(o.stock_item_id) : null;
                  return (
                    <tr key={o.id}>
                      <td>
                        <strong style={{ fontWeight: 500 }}>{o.customer_name}</strong>
                        <div style={{ fontSize: '0.75rem', color: 'var(--ink-faint)' }}>{o.customer_email ?? o.reference}</div>
                      </td>
                      <td>{o.stock_items ? `${o.stock_items.name} · ${o.stock_items.size}` : '—'}</td>
                      <td>{o.quantity}</td>
                      <td><span className="pill pill-out">{s?.on_hand ?? 0}</span></td>
                      <td style={{ fontSize: '0.8rem' }}>{new Date(o.ordered_at).toLocaleDateString('en-AU')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
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
            <h2>All orders</h2>
            <button className="btn-solid" onClick={() => setModal('order')}>Add order</button>
          </div>
          <div className="filters">
            <input placeholder="Search by name or item" value={orderSearch} onChange={(e) => setOrderSearch(e.target.value)} />
            <select value={orderFilter} onChange={(e) => setOrderFilter(e.target.value)}>
              <option value="">All orders</option>
              <option value="pending">Unpaid</option>
              <option value="paid">Paid, not handed over</option>
              <option value="distributed">Handed over</option>
            </select>
          </div>
          <table>
            <thead>
              <tr><th>Who</th><th>Item</th><th>Qty</th><th>Total</th><th>Payment</th><th>Handover</th><th>Source</th><th></th></tr>
            </thead>
            <tbody>
              {visibleOrders.length === 0 ? (
                <tr><td colSpan={8}><div className="empty">No orders match.</div></td></tr>
              ) : visibleOrders.map((o) => (
                <tr key={o.id}>
                  <td>
                    <strong style={{ fontWeight: 500 }}>{o.customer_name}</strong>
                    <div style={{ fontSize: '0.75rem', color: 'var(--ink-faint)' }}>{o.customer_email ?? o.reference}</div>
                  </td>
                  <td>{o.stock_items ? `${o.stock_items.name} · ${o.stock_items.size}` : '—'}</td>
                  <td>{o.quantity}</td>
                  <td>{money(o.unit_price * o.quantity)}</td>
                  <td>{o.payment_status === 'paid'
                    ? <span className="pill pill-ok">Paid</span>
                    : <span className="pill pill-out">Unpaid</span>}</td>
                  <td>{o.distributed_at
                    ? <span style={{ fontSize: '0.78rem' }}>{new Date(o.distributed_at).toLocaleDateString('en-AU')}</span>
                    : <span className="pill pill-grey">Not yet</span>}</td>
                  <td><span className="pill pill-grey">{o.source === 'wix' ? 'Wix' : 'Manual'}</span></td>
                  <td style={{ display: 'flex', gap: 6 }}>
                    {o.payment_status === 'pending' && (
                      <button className="btn-mini" onClick={() => markPaid(o.id)}>Mark paid</button>
                    )}
                    {o.payment_status === 'paid' && !o.distributed_at && (
                      <button className="btn-mini" onClick={() => handOver(o.id)}>Hand over</button>
                    )}
                    {o.distributed_at && (
                      <button className="btn-mini" onClick={() => undoHandover(o.id)}>Undo</button>
                    )}
                    <button className="btn-mini" onClick={() => removeOrder(o.id)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
              <div className="field"><label>Price (AUD)</label><input name="price" type="number" step="0.01" min="0" defaultValue="0" /></div>
              <div className="field"><label>On hand now</label><input name="quantity" type="number" min="0" defaultValue="0" /></div>
            </div>
            <div className="field-pair">
              <div className="field"><label>Warn when available drops to</label><input name="alert" type="number" min="0" defaultValue="3" /></div>
              <div className="field"><label>Target to hold</label><input name="target" type="number" min="0" defaultValue="5" /></div>
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
              <input name="quantity" type="number" min="0" defaultValue={editing.on_hand} autoFocus /></div>
            <div className="field"><label>Price (AUD)</label>
              <input name="price" type="number" step="0.01" min="0" defaultValue={editing.price} /></div>
            <div className="field-pair">
              <div className="field"><label>Warn when available drops to</label>
                <input name="alert" type="number" min="0" defaultValue={editing.low_stock_alert} /></div>
              <div className="field"><label>Target to hold</label>
                <input name="target" type="number" min="0" defaultValue={editing.target_level} /></div>
            </div>
            <div className="modal-actions">
              <button type="button" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="btn-solid">Save</button>
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
              <div className="field"><label>Quantity</label><input name="quantity" type="number" min="1" defaultValue="1" /></div>
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
