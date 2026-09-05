'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-client';
import { StockItem, Order, stockStatus, money } from '@/lib/types';

const CATEGORIES = ['T-Shirt', 'Hoodie', 'Cap', 'Jacket', 'Shorts', 'Other'];
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'One size'];

export default function Tracker({ userEmail }: { userEmail: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [tab, setTab] = useState<'stock' | 'orders'>('stock');
  const [items, setItems] = useState<StockItem[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<'item' | 'order' | 'edit' | null>(null);
  const [editing, setEditing] = useState<StockItem | null>(null);
  const [message, setMessage] = useState('');

  const [stockSearch, setStockSearch] = useState('');
  const [stockCat, setStockCat] = useState('');
  const [stockLevel, setStockLevel] = useState('');
  const [orderSearch, setOrderSearch] = useState('');
  const [orderFilter, setOrderFilter] = useState('');

  async function load() {
    const [{ data: s }, { data: o }] = await Promise.all([
      supabase.from('stock_items').select('*').order('name').order('size'),
      supabase
        .from('orders')
        .select('*, stock_items(name, size)')
        .order('ordered_at', { ascending: false }),
    ]);
    setItems((s as StockItem[]) ?? []);
    setOrders((o as Order[]) ?? []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function flash(text: string) {
    setMessage(text);
    setTimeout(() => setMessage(''), 4000);
  }

  // ---- Stock actions -------------------------------------------------
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
      low_stock_alert: Number(f.get('alert')) || 5,
      wix_product_id: String(f.get('wix') ?? '').trim() || null,
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
    const diff = newQty - editing.quantity;

    const { error } = await supabase
      .from('stock_items')
      .update({
        quantity: newQty,
        price: Number(f.get('price')) || 0,
        low_stock_alert: Number(f.get('alert')) || 0,
        wix_product_id: String(f.get('wix') ?? '').trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', editing.id);

    if (error) return flash(error.message);

    if (diff !== 0) {
      await supabase.from('stock_movements').insert({
        stock_item_id: editing.id,
        change: diff,
        reason: 'Manual adjustment',
        created_by: userEmail,
      });
    }

    setModal(null);
    setEditing(null);
    flash('Stock updated.');
    load();
  }

  async function deleteItem(id: string) {
    if (!confirm('Remove this item? Orders linked to it will be kept.')) return;
    const { error } = await supabase.from('stock_items').delete().eq('id', id);
    if (error) return flash(error.message);
    flash('Item removed.');
    load();
  }

  // ---- Order actions -------------------------------------------------
  async function addOrder(form: HTMLFormElement) {
    const f = new FormData(form);
    const name = String(f.get('customer') ?? '').trim();
    if (!name) return flash('Customer name is required.');

    const itemId = String(f.get('item'));
    const item = items.find((i) => i.id === itemId);
    const qty = Number(f.get('quantity')) || 1;

    if (item && qty > item.quantity) {
      if (!confirm(`Only ${item.quantity} in stock. Record the order anyway?`)) return;
    }

    const { error } = await supabase.from('orders').insert({
      customer_name: name,
      customer_email: String(f.get('email') ?? '').trim() || null,
      stock_item_id: itemId || null,
      quantity: qty,
      unit_price: item?.price ?? 0,
      payment_status: String(f.get('status')),
      ordered_at: String(f.get('date') || new Date().toISOString().slice(0, 10)),
      source: 'manual',
    });

    if (error) return flash(error.message);
    setModal(null);
    flash('Order recorded. Stock adjusted.');
    load();
  }

  async function markPaid(id: string) {
    await supabase.from('orders').update({ payment_status: 'paid' }).eq('id', id);
    flash('Marked as paid.');
    load();
  }

  async function markDistributed(id: string) {
    await supabase
      .from('orders')
      .update({ distributed_at: new Date().toISOString() })
      .eq('id', id);
    flash('Marked as distributed.');
    load();
  }

  async function deleteOrder(id: string) {
    if (!confirm('Remove this order? The stock will be returned.')) return;
    await supabase.from('orders').delete().eq('id', id);
    flash('Order removed and stock returned.');
    load();
  }

  async function signOut() {
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  // ---- Derived data --------------------------------------------------
  const lowCount = items.filter((i) => stockStatus(i) === 'low').length;
  const outCount = items.filter((i) => stockStatus(i) === 'out').length;
  const pendingCount = orders.filter((o) => o.payment_status === 'pending').length;
  const undelivered = orders.filter((o) => o.payment_status === 'paid' && !o.distributed_at).length;
  const collected = orders
    .filter((o) => o.payment_status === 'paid')
    .reduce((s, o) => s + o.unit_price * o.quantity, 0);
  const owed = orders
    .filter((o) => o.payment_status === 'pending')
    .reduce((s, o) => s + o.unit_price * o.quantity, 0);

  const visibleItems = items.filter((i) => {
    const q = stockSearch.toLowerCase();
    return (
      (!q || i.name.toLowerCase().includes(q)) &&
      (!stockCat || i.category === stockCat) &&
      (!stockLevel || stockStatus(i) === stockLevel)
    );
  });

  const visibleOrders = orders.filter((o) => {
    const q = orderSearch.toLowerCase();
    const label = `${o.customer_name} ${o.stock_items?.name ?? ''}`.toLowerCase();
    const state = o.distributed_at ? 'distributed' : o.payment_status;
    return (!q || label.includes(q)) && (!orderFilter || state === orderFilter);
  });

  const maxQty = Math.max(...items.map((i) => i.quantity), 1);

  if (loading) return <div className="shell"><p style={{ color: 'var(--ink-soft)' }}>Loading…</p></div>;

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <h1>Merchandise Tracker</h1>
          <p>Signed in as {userEmail}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div className="tabs">
            <button className="tab" data-active={tab === 'stock'} onClick={() => setTab('stock')}>Stock</button>
            <button className="tab" data-active={tab === 'orders'} onClick={() => setTab('orders')}>Orders</button>
          </div>
          <button onClick={signOut}>Sign out</button>
        </div>
      </div>

      {message && <div className="note note-ok" style={{ marginBottom: '1rem' }}>{message}</div>}

      <div className="metrics">
        <div className="metric">
          <span>Stock lines</span>
          <strong>{items.length}</strong>
          <small>{outCount} out of stock</small>
        </div>
        <div className="metric">
          <span>Low stock</span>
          <strong style={{ color: lowCount ? 'var(--warn)' : undefined }}>{lowCount}</strong>
          <small>Need restocking</small>
        </div>
        <div className="metric">
          <span>Awaiting handover</span>
          <strong>{undelivered}</strong>
          <small>Paid but not distributed</small>
        </div>
        <div className="metric">
          <span>Money collected</span>
          <strong>{money(collected)}</strong>
          <small>{money(owed)} still owed</small>
        </div>
      </div>

      {tab === 'stock' && (
        <div className="card">
          <div className="card-head">
            <h2>Inventory</h2>
            <button className="btn-solid" onClick={() => setModal('item')}>Add item</button>
          </div>
          <div className="filters">
            <input placeholder="Search items" value={stockSearch} onChange={(e) => setStockSearch(e.target.value)} />
            <select value={stockCat} onChange={(e) => setStockCat(e.target.value)}>
              <option value="">All categories</option>
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
            <select value={stockLevel} onChange={(e) => setStockLevel(e.target.value)}>
              <option value="">All levels</option>
              <option value="ok">In stock</option>
              <option value="low">Low stock</option>
              <option value="out">Out of stock</option>
            </select>
          </div>
          <table>
            <thead>
              <tr>
                <th>Item</th><th>Size</th><th>Price</th><th>On hand</th><th>Status</th><th>Wix linked</th><th></th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.length === 0 ? (
                <tr><td colSpan={7}><div className="empty">No items yet. Add your first one to get started.</div></td></tr>
              ) : visibleItems.map((i) => {
                const st = stockStatus(i);
                const colour = st === 'ok' ? 'var(--accent)' : st === 'low' ? 'var(--warn)' : 'var(--alert)';
                return (
                  <tr key={i.id}>
                    <td>
                      <strong style={{ fontWeight: 500 }}>{i.name}</strong>
                      <div style={{ fontSize: '0.75rem', color: 'var(--ink-faint)' }}>{i.category}</div>
                    </td>
                    <td>{i.size}</td>
                    <td>{money(i.price)}</td>
                    <td>
                      {i.quantity}
                      <span className="bar"><i style={{ width: `${Math.round((i.quantity / maxQty) * 100)}%`, background: colour }} /></span>
                    </td>
                    <td><span className={`pill pill-${st}`}>{st === 'ok' ? 'In stock' : st === 'low' ? 'Low' : 'Out'}</span></td>
                    <td>{i.wix_product_id
                      ? <span className="pill pill-ok">Linked</span>
                      : <span className="pill pill-grey">Not linked</span>}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      <button className="btn-mini" onClick={() => { setEditing(i); setModal('edit'); }}>Adjust</button>
                      <button className="btn-mini" onClick={() => deleteItem(i.id)}>Remove</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'orders' && (
        <div className="card">
          <div className="card-head">
            <h2>Orders</h2>
            <button className="btn-solid" onClick={() => setModal('order')}>Add order</button>
          </div>
          <div className="filters">
            <input placeholder="Search by name or item" value={orderSearch} onChange={(e) => setOrderSearch(e.target.value)} />
            <select value={orderFilter} onChange={(e) => setOrderFilter(e.target.value)}>
              <option value="">All orders</option>
              <option value="pending">Unpaid</option>
              <option value="paid">Paid, not handed over</option>
              <option value="distributed">Distributed</option>
            </select>
          </div>
          <table>
            <thead>
              <tr>
                <th>Customer</th><th>Item</th><th>Qty</th><th>Total</th><th>Payment</th><th>Handover</th><th>Source</th><th></th>
              </tr>
            </thead>
            <tbody>
              {visibleOrders.length === 0 ? (
                <tr><td colSpan={8}><div className="empty">No orders match. Add one, or wait for the next Wix sync.</div></td></tr>
              ) : visibleOrders.map((o) => (
                <tr key={o.id}>
                  <td>
                    <strong style={{ fontWeight: 500 }}>{o.customer_name}</strong>
                    <div style={{ fontSize: '0.75rem', color: 'var(--ink-faint)' }}>{o.customer_email ?? o.reference}</div>
                  </td>
                  <td>{o.stock_items ? `${o.stock_items.name} · ${o.stock_items.size}` : '—'}</td>
                  <td>{o.quantity}</td>
                  <td>{money(o.unit_price * o.quantity)}</td>
                  <td>
                    {o.payment_status === 'paid'
                      ? <span className="pill pill-ok">Paid</span>
                      : <span className="pill pill-out">Unpaid</span>}
                  </td>
                  <td>
                    {o.distributed_at
                      ? <span style={{ fontSize: '0.78rem' }}>{new Date(o.distributed_at).toLocaleDateString('en-AU')}</span>
                      : <span className="pill pill-grey">Not yet</span>}
                  </td>
                  <td><span className="pill pill-grey">{o.source === 'wix' ? 'Wix' : 'Manual'}</span></td>
                  <td style={{ display: 'flex', gap: 6 }}>
                    {o.payment_status === 'pending' && (
                      <button className="btn-mini" onClick={() => markPaid(o.id)}>Mark paid</button>
                    )}
                    {o.payment_status === 'paid' && !o.distributed_at && (
                      <button className="btn-mini" onClick={() => markDistributed(o.id)}>Handed over</button>
                    )}
                    <button className="btn-mini" onClick={() => deleteOrder(o.id)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal === 'item' && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setModal(null)}>
          <form className="modal" onSubmit={(e) => { e.preventDefault(); addItem(e.currentTarget); }}>
            <h3>Add stock item</h3>
            <div className="field"><label>Item name</label><input name="name" placeholder="Club Hoodie 2026" autoFocus /></div>
            <div className="field-pair">
              <div className="field"><label>Category</label><select name="category">{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></div>
              <div className="field"><label>Size</label><select name="size">{SIZES.map((s) => <option key={s}>{s}</option>)}</select></div>
            </div>
            <div className="field-pair">
              <div className="field"><label>Price (AUD)</label><input name="price" type="number" step="0.01" min="0" defaultValue="0" /></div>
              <div className="field"><label>Quantity on hand</label><input name="quantity" type="number" min="0" defaultValue="0" /></div>
            </div>
            <div className="field"><label>Warn me when stock drops to</label><input name="alert" type="number" min="0" defaultValue="5" /></div>
            <div className="field">
              <label>Wix product ID (optional)</label>
              <input name="wix" placeholder="Paste from your Wix product page" />
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
            <h3>Adjust {editing.name} · {editing.size}</h3>
            <div className="field"><label>Quantity on hand</label><input name="quantity" type="number" min="0" defaultValue={editing.quantity} autoFocus /></div>
            <div className="field"><label>Price (AUD)</label><input name="price" type="number" step="0.01" min="0" defaultValue={editing.price} /></div>
            <div className="field"><label>Warn me when stock drops to</label><input name="alert" type="number" min="0" defaultValue={editing.low_stock_alert} /></div>
            <div className="field"><label>Wix product ID</label><input name="wix" defaultValue={editing.wix_product_id ?? ''} /></div>
            <div className="modal-actions">
              <button type="button" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="btn-solid">Save changes</button>
            </div>
          </form>
        </div>
      )}

      {modal === 'order' && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setModal(null)}>
          <form className="modal" onSubmit={(e) => { e.preventDefault(); addOrder(e.currentTarget); }}>
            <h3>Record an order</h3>
            <div className="field"><label>Customer name</label><input name="customer" autoFocus /></div>
            <div className="field"><label>Email (optional)</label><input name="email" type="email" placeholder="name@gmail.com" /></div>
            <div className="field">
              <label>Item</label>
              <select name="item">
                {items.map((i) => (
                  <option key={i.id} value={i.id}>{i.name} · {i.size} ({i.quantity} left)</option>
                ))}
              </select>
            </div>
            <div className="field-pair">
              <div className="field"><label>Quantity</label><input name="quantity" type="number" min="1" defaultValue="1" /></div>
              <div className="field">
                <label>Payment</label>
                <select name="status"><option value="pending">Not paid yet</option><option value="paid">Paid</option></select>
              </div>
            </div>
            <div className="field"><label>Date ordered</label><input name="date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} /></div>
            <div className="modal-actions">
              <button type="button" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="btn-solid">Record order</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
