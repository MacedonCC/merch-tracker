'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase-client';
import { sizeRank } from '@/lib/types';
import type { MemberPermissions } from '@/lib/member';

// The nearest ancestor that would clip an overflowing child (the
// Orders card has overflow: hidden), or null if only the viewport does.
function clippingAncestor(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (getComputedStyle(p).overflowY !== 'visible') return p;
  }
  return null;
}

// A small "..." menu for a row's secondary actions — Remove today,
// anything else later — kept separate from the one visible primary
// action per row (Mark paid / Hand over / Undo).
function RowMenu({ actions }: { actions: { label: string; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Opens downwards unless that would run past the clipping container
  // (or the viewport) and there's more room above — so the last rows'
  // menus flip up instead of being cut off. Measured before paint, so
  // there's no visible jump.
  useLayoutEffect(() => {
    if (!open || !ref.current || !menuRef.current) return;
    const btn = ref.current.getBoundingClientRect();
    const menuHeight = menuRef.current.getBoundingClientRect().height + 4;
    const clip = clippingAncestor(ref.current)?.getBoundingClientRect();
    const spaceBelow = Math.min(clip?.bottom ?? Infinity, window.innerHeight) - btn.bottom;
    const spaceAbove = btn.top - Math.max(clip?.top ?? -Infinity, 0);
    setDropUp(menuHeight > spaceBelow && spaceAbove > spaceBelow);
  }, [open]);

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
        <div className="row-menu" role="menu" ref={menuRef} data-up={dropUp}>
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

// Must stay in step with guessCategory() in app/api/wix-import, which
// assigns one of these to any line it creates. A category the dropdown
// does not list would be invisible to the Stock page filter.
const CATEGORIES = ['T-Shirt', 'Hoodie', 'Jacket', 'Shorts', 'Pants', 'Cap', 'Hat', 'Beanie', 'Other'];
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

// ---- Restock: demand from last season's sales -----------------------
// The season runs 1 Aug to 28 Feb. Restock projects this season's needs
// from the SAME window last season, which is the only like-for-like
// comparison available — a cricket club's sales are violently seasonal,
// so comparing against a trailing 12 months or a rolling 90 days would
// read August's spike as growth and April's silence as collapse.
//
// Dates come from orders.ordered_at (when it was placed), not
// created_at (when the row was imported — the historical Wix backfill
// would stack years of orders onto one afternoon) and not
// distributed_at (when it was collected, which is fulfilment, not
// demand).
//
// Bounds are half-open. An inclusive `<= 28 Feb` would resolve to
// midnight at the START of the 28th and silently drop that whole day.
//
// The window is pinned to Australia/Melbourne rather than the device's
// timezone, so a committee member checking the list from overseas sees
// the same season as everyone at the club. That matters at both ends:
// the boundaries themselves, and which season we are in at all — a
// laptop set to UTC on 1 August is still 31 July there while it is
// already August at the ground.
//
// The zone's offset is read from Intl rather than hardcoded, because it
// is not constant across the window: Melbourne is UTC+10 (AEST) on
// 1 August but UTC+11 (AEDT) on 1 March, so a single fixed offset would
// put one end of the window an hour out.
const CLUB_TZ = 'Australia/Melbourne';

// Milliseconds to add to a UTC instant to get the club's wall clock.
function clubOffsetMs(utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CLUB_TZ,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Some engines report midnight as hour 24 under hour12: false.
  const hour = at('hour') === 24 ? 0 : at('hour');
  const asIfUtc = Date.UTC(at('year'), at('month') - 1, at('day'), hour, at('minute'), at('second'));
  return asIfUtc - utcMs;
}

// The instant at which the club's wall clock reads this local midnight.
function clubMidnight(year: number, monthIndex: number, day: number): Date {
  const naive = Date.UTC(year, monthIndex, day);
  // Subtracting the offset at the naive instant lands very close; a
  // second pass corrects the rare case where that first guess falls on
  // the far side of a DST transition.
  const first = naive - clubOffsetMs(naive);
  const second = naive - clubOffsetMs(first);
  return new Date(second);
}

// Always the most recently COMPLETED Aug-Feb season, never one still
// running — a half-finished season would under-project every line,
// badly in September and catastrophically in August.
//
// Which year that season started depends on where we are in the club's
// calendar, judged on the club's clock rather than the device's:
//
//   Jan, Feb   the season that began last August is still running, so
//              the last completed one began the August before that
//   Mar - Jul  the season that began last August finished in February,
//              so it is the most recent completed one
//   Aug - Dec  a new season has begun and is running, so the most
//              recent completed one began last August
//
// Mar-Jul and Aug-Dec therefore land on the same answer, and only
// Jan-Feb reaches back an extra year. Getting this wrong is quiet: the
// page still renders a plausible list, just built from the wrong year.
function lastSeasonWindow(now = new Date()): { start: Date; end: Date; label: string } {
  const clubNow = new Date(now.getTime() + clubOffsetMs(now.getTime()));
  const clubYear = clubNow.getUTCFullYear();
  const clubMonth = clubNow.getUTCMonth();
  const seasonStartYear = clubMonth <= 1 ? clubYear - 2 : clubYear - 1;

  return {
    start: clubMidnight(seasonStartYear, 7, 1),
    end: clubMidnight(seasonStartYear + 1, 2, 1),
    label: `1 Aug ${seasonStartYear} – 28 Feb ${seasonStartYear + 1}`,
  };
}

interface RestockLine {
  id: string;
  size: string;
  price: number;
  available: number;
  shortfall: number;
  /** null when the line could not have sold in the window at all. */
  demand: number | null;
  suggested: number;
}

interface RestockGroup {
  name: string;
  lines: RestockLine[];
  units: number;
  value: number;
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-AU');

// Item name with its size as a small trailing pill, so a long product
// name doesn't swallow the size.
const itemLabel = (item: { name: string; size: string } | null | undefined) =>
  item ? (
    <>
      {item.name} <span className="size-pill">{item.size}</span>
    </>
  ) : '—';

// ---- Stock matrix ---------------------------------------------------
// The Stock page is one row per product and one column per size, so the
// whole cupboard reads as a single grid: scan a column to compare a
// size across products, scan a row to see one product's spread.

// Fixed column order. Stock rows store size as free text, so each is
// normalised onto one of these by sizeColumn(); anything unrecognised
// lands in a trailing Other column rather than being dropped — the grid
// must never hide stock.
const SIZE_COLUMNS = ['JNR8', 'JNR10', 'JNR12', 'JNR14', 'JNR16', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', 'One size'];
const OTHER_COLUMN = 'Other';
const MATRIX_COLUMNS = [...SIZE_COLUMNS, OTHER_COLUMN];

const CANONICAL_SIZES = new Map(SIZE_COLUMNS.map((c) => [c.toLowerCase(), c]));
const SIZE_ALIASES: Record<string, string> = {
  small: 'S',
  medium: 'M',
  large: 'L',
  'one size fits all': 'One size',
};

function sizeColumn(size: string): string {
  const key = size.trim().toLowerCase().replace(/\s+/g, ' ');
  return CANONICAL_SIZES.get(key) ?? SIZE_ALIASES[key] ?? OTHER_COLUMN;
}

// Worst-first: a product with an oversold size outranks one that is
// merely out, which outranks low. Also the row sort order.
const STATUS_RANK: Record<StockRow['stock_status'], number> = { oversold: 0, out: 1, low: 2, ok: 3 };

interface StockGroup {
  key: string;
  name: string;
  category: string;
  rows: StockRow[];
  // Column -> the stock lines in it. Usually one, but two rows can
  // normalise onto the same column (e.g. "Small" and "S"), and Other can
  // hold several — every line keeps its own clickable entry.
  cells: Map<string, StockRow[]>;
  onHand: number;
  owed: number;
  worst: StockRow['stock_status'];
}

function groupStock(rows: StockRow[]): StockGroup[] {
  const map = new Map<string, StockRow[]>();
  for (const r of rows) {
    const key = r.name.trim();
    const list = map.get(key);
    if (list) list.push(r);
    else map.set(key, [r]);
  }

  return Array.from(map.entries()).map(([key, rows]) => {
    const cells = new Map<string, StockRow[]>();
    for (const r of rows) {
      const col = sizeColumn(r.size);
      const list = cells.get(col);
      if (list) list.push(r);
      else cells.set(col, [r]);
    }
    cells.forEach((list) => list.sort((a, b) => a.size.localeCompare(b.size)));

    return {
      key,
      name: key,
      category: rows[0].category,
      rows,
      cells,
      onHand: rows.reduce((n, s) => n + s.on_hand, 0),
      owed: rows.reduce((n, s) => n + s.committed, 0),
      worst: rows.reduce<StockRow['stock_status']>(
        (w, s) => (STATUS_RANK[s.stock_status] < STATUS_RANK[w] ? s.stock_status : w),
        'ok'
      ),
    };
  });
}

// Each order has two independent facts — paid or not, handed over or
// not — which is four combinations, and each one is now a named state:
//
//   not paid, not handed over  -> unpaid            (chase the money)
//   paid,     not handed over  -> ready | waiting   (depending on stock)
//   not paid, handed over      -> owing             (they have it, chase the money)
//   paid,     handed over      -> done
//
// PAYMENT IS TESTED BEFORE HANDOVER, and that order matters. This used
// to read `if (o.distributed_at) return 'done'` first, which filed an
// unpaid-but-handed-over order under "nothing to do" — precisely the
// debt most worth chasing. Nothing could create that combination until
// /sell grew a "taking it now" option, so it never showed up in the
// data; it would have the moment the option shipped.
//
// 'refunded' counts as not paid here, same as 'pending'. Nothing in the
// app sets it, so this is theoretical, but a refunded order that was
// handed over now reads as owing rather than done.
type OrderState = 'unpaid' | 'owing' | 'ready' | 'waiting' | 'done';

// Ready vs waiting is a question about a QUEUE, not about one order,
// so the whole list is classified at once rather than each row on its
// own. The previous version asked "is there enough on hand for this
// order?" independently for every row, which meant two orders for the
// same size both read as Ready off a single garment: the first person
// to arrive would take it and the second would find an empty cupboard
// and a screen still promising it was there.
//
// Stock is allocated oldest order first. Each paid, not-yet-handed-over
// order claims what it needs from what is left after every earlier
// order for the same size, so exactly as many rows say Ready as there
// are garments to satisfy them. Ties break on id so the order is
// stable between renders.
//
// "Hand over all" needs no separate rule: it is built from the rows
// already classified Ready, so it can only ever hand over what has
// actually been allocated.
function classifyOrders(
  orders: OrderRow[],
  byId: Map<string, StockRow>
): Map<string, OrderState> {
  const states = new Map<string, OrderState>();
  const queue: OrderRow[] = [];

  for (const o of orders) {
    const paid = o.payment_status === 'paid';
    if (o.distributed_at) states.set(o.id, paid ? 'done' : 'owing');
    else if (!paid) states.set(o.id, 'unpaid');
    else queue.push(o);
  }

  queue.sort((a, b) => {
    const t = new Date(a.ordered_at).getTime() - new Date(b.ordered_at).getTime();
    return t !== 0 ? t : a.id.localeCompare(b.id);
  });

  const remaining = new Map<string, number>();
  for (const o of queue) {
    const key = o.stock_item_id ?? '';
    if (!remaining.has(key)) {
      const s = o.stock_item_id ? byId.get(o.stock_item_id) : null;
      remaining.set(key, s ? s.on_hand : 0);
    }
    const left = remaining.get(key) ?? 0;
    if (left >= o.quantity) {
      states.set(o.id, 'ready');
      remaining.set(key, left - o.quantity);
    } else {
      states.set(o.id, 'waiting');
    }
  }

  return states;
}

// Ordered so the two money-chasing states sit together on the left and
// the two stock-handling states in the middle.
// Ordered by what someone opening the page actually does: hand things
// over first, chase stock, then chase money, with Done and All at the
// end as lookups rather than work. Six of them, which is why the row is
// a 6-up grid on desktop and 3 x 2 on a phone rather than a wrapping
// flex line that reflows differently at every width.
const CHIPS: { key: 'all' | OrderState; label: string }[] = [
  { key: 'ready', label: 'Ready' },
  { key: 'waiting', label: 'Waiting on stock' },
  { key: 'unpaid', label: 'Unpaid' },
  { key: 'owing', label: 'Has gear, unpaid' },
  { key: 'done', label: 'Done' },
  { key: 'all', label: 'All' },
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
  const [listedAt, setListedAt] = useState<Map<string, string | null>>(new Map());
  const [showNoHistory, setShowNoHistory] = useState(false);
  const [pushing, setPushing] = useState(false);
  // Persistent, unlike flash(): a push result must not vanish after
  // four seconds while the person is still reading it.
  const [pushSummary, setPushSummary] = useState<string | null>(null);

  async function load() {
    // wix_listed_at lives on stock_items, not on the stock_overview
    // view, so it is fetched alongside and merged by id rather than
    // reshaping the view.
    const [{ data: s }, { data: o }, { data: listed }] = await Promise.all([
      supabase.from('stock_overview').select('*').order('name').order('size'),
      supabase
        .from('orders')
        .select('*, stock_items(name, size)')
        .order('ordered_at', { ascending: false }),
      supabase.from('stock_items').select('id, wix_listed_at'),
    ]);
    setStock((s as StockRow[]) ?? []);
    setOrders((o as OrderRow[]) ?? []);
    setListedAt(
      new Map(
        ((listed ?? []) as Array<{ id: string; wix_listed_at: string | null }>).map((r) => [
          r.id,
          r.wix_listed_at,
        ])
      )
    );
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

  // Sets Wix inventory from the tracker's `available`, taking
  // spoken-for sizes off sale. Reports first, then asks: this changes
  // the public shop, so it should not happen on a single stray tap.
  //
  // EVERY outcome ends in a visible message, including cancelling and
  // including a push that changed nothing. The first version returned
  // silently when the confirm was dismissed, which made 'I cancelled'
  // and 'it did nothing' look identical, and left no way to tell which
  // had happened.
  async function pushToWix() {
    setPushing(true);
    setPushSummary(null);
    try {
      const preview = await fetch('/api/wix-push').then((r) => r.json());
      if (!preview.ok) {
        setPushSummary(preview.reason ?? preview.error ?? 'Could not reach Wix.');
        return;
      }
      const c = preview.counts;
      const summary =
        `Set ${c.linesConsidered} sizes in Wix?\n\n` +
        `${c.wouldStayOnSale} stay on sale\n` +
        `${c.wouldBlock} go to zero (blocked online)\n` +
        `${c.wouldChange} would actually change\n` +
        (c.skipped ? `${c.skipped} skipped — no Wix link\n` : '') +
        (preview.pushEnabled
          ? ''
          : '\nWIX_PUSH_ENABLED is off, so nothing will be sent.');
      if (!window.confirm(summary)) {
        setPushSummary('Push cancelled — nothing was sent to Wix.');
        return;
      }

      const result = await fetch('/api/wix-push', { method: 'POST' }).then((r) => r.json());
      const rc = result.counts;
      setPushSummary(
        result.error
          ? `Push failed: ${result.error}`
          : !result.wrote
            ? result.reason
            : `${result.reason} ${rc.wouldBlock} blocked, ${rc.newlyTracked} newly tracked` +
              (rc.failed ? `, ${rc.failed} FAILED.` : '.')
      );
      load();
    } catch {
      setPushSummary('Could not reach Wix.');
    } finally {
      setPushing(false);
    }
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
  // Memoised because classifyOrders() takes it as a dependency; a fresh
  // Map every render would defeat that memo.
  const byId = useMemo(() => new Map(stock.map((s) => [s.id, s])), [stock]);

  // Restock is projected from last season's sales, NOT target_level.
  // target_level is left in place on stock_items and still drives
  // stock_overview.suggested_order; this page simply stops reading it.
  const season = useMemo(() => lastSeasonWindow(), []);

  const restockGroups = useMemo<RestockGroup[]>(() => {
    // Demand = units ordered in the window, counting an order once it
    // is either paid or handed over. An order that is neither is an
    // abandoned payment link, and counting it would let someone inflate
    // next season's buy by starting checkouts they never finish.
    const demandById = new Map<string, number>();
    for (const o of orders) {
      if (!o.stock_item_id) continue;
      if (o.payment_status !== 'paid' && !o.distributed_at) continue;
      const placed = new Date(o.ordered_at);
      if (placed < season.start || placed >= season.end) continue;
      demandById.set(o.stock_item_id, (demandById.get(o.stock_item_id) ?? 0) + o.quantity);
    }

    const byName = new Map<string, RestockGroup>();
    for (const s of stock) {
      // "No history" means the line COULD NOT have sold in the window,
      // which is a question about when it went on sale, not whether it
      // is linked today. wix_listed_at answers it directly; the old
      // proxy ("is it linked to Wix?") broke the moment a catalogue
      // import linked 39 lines at once, making every one of them read
      // as having sold nothing last season.
      //
      // Real sales always win. If a line sold in the window it self
      // evidently was on sale, whatever its recorded listing date says.
      const sold = demandById.get(s.id);
      const listed = listedAt.get(s.id);
      const onSaleBeforeSeason = listed ? new Date(listed) < season.start : false;
      const demand = sold ?? (onSaleBeforeSeason ? 0 : null);

      // shortfall is shown but NOT added to the suggestion: it equals
      // -available whenever stock is oversold, so adding both would
      // count the oversold units twice.
      const suggested = Math.max(0, Math.ceil((demand ?? 0) - s.available));

      // A line with known demand and nothing to buy is simply not on
      // the shopping list. A "No history" line with nothing to buy is
      // not either, but it is not hidden: it moves to the collapsed
      // "new to the shop" block below, so an absence of evidence is
      // never silently rendered as a zero.
      //
      // A "No history" line WITH something to buy stays in the main
      // list, because that quantity comes from a shortfall - paid
      // orders the cupboard cannot fill - which is a real obligation
      // regardless of how new the line is.
      if (suggested === 0 && demand !== null) continue;

      const line: RestockLine = {
        id: s.id,
        size: s.size,
        price: s.price,
        available: s.available,
        shortfall: s.shortfall,
        demand,
        suggested,
      };
      const group = byName.get(s.name);
      if (group) group.lines.push(line);
      else byName.set(s.name, { name: s.name, lines: [line], units: 0, value: 0 });
    }

    return Array.from(byName.values())
      .map((g) => {
        g.lines.sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
        g.units = g.lines.reduce((n, l) => n + l.suggested, 0);
        g.value = g.lines.reduce((n, l) => n + l.suggested * l.price, 0);
        return g;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [stock, orders, season, listedAt]);

  // Split: anything to buy goes in the main list; the rest is new stock
  // with no sales history to judge it by.
  const restockOrder = restockGroups
    .map((g) => ({ ...g, lines: g.lines.filter((l) => l.suggested > 0) }))
    .filter((g) => g.lines.length > 0)
    .map((g) => ({
      ...g,
      units: g.lines.reduce((n, l) => n + l.suggested, 0),
      value: g.lines.reduce((n, l) => n + l.suggested * l.price, 0),
    }));

  const noHistoryGroups = restockGroups
    .map((g) => ({ ...g, lines: g.lines.filter((l) => l.suggested === 0 && l.demand === null) }))
    .filter((g) => g.lines.length > 0);
  const noHistoryCount = noHistoryGroups.reduce((n, g) => n + g.lines.length, 0);

  const restockUnits = restockOrder.reduce((n, g) => n + g.units, 0);
  const restockValue = restockOrder.reduce((n, g) => n + g.value, 0);

  const totalOnHand = stock.reduce((n, s) => n + s.on_hand, 0);
  const totalCommitted = stock.reduce((n, s) => n + s.committed, 0);
  const totalShort = stock.reduce((n, s) => n + s.shortfall, 0);
  const toOrder = restockUnits;
  const owed = orders
    .filter((o) => o.payment_status === 'pending')
    .reduce((n, o) => n + o.unit_price * o.quantity, 0);

  // Search and category match the product; the status filter keeps any
  // product with at least one size in that state (the non-matching
  // cells are dimmed rather than dropped, so the row still adds up).
  const visibleGroups = groupStock(stock)
    .filter((g) => {
      const q = search.trim().toLowerCase();
      if (q && !g.name.toLowerCase().includes(q)) return false;
      if (cat && !g.rows.some((s) => s.category === cat)) return false;
      if (level && !g.rows.some((s) => s.stock_status === level)) return false;
      return true;
    })
    .sort((a, b) => STATUS_RANK[a.worst] - STATUS_RANK[b.worst] || a.name.localeCompare(b.name));

  // Only the size columns some visible product actually uses, so a
  // search for caps doesn't drag along thirteen empty columns.
  const visibleColumns = MATRIX_COLUMNS.filter((c) => visibleGroups.some((g) => g.cells.has(c)));

  const isDimmed = (s: StockRow) => Boolean(level) && s.stock_status !== level;

  const orderStates = useMemo(() => classifyOrders(orders, byId), [orders, byId]);
  const classifiedOrders = orders.map((o) => ({
    order: o,
    state: orderStates.get(o.id) ?? 'unpaid',
  }));

  const orderCounts = {
    all: classifiedOrders.length,
    unpaid: classifiedOrders.filter((c) => c.state === 'unpaid').length,
    owing: classifiedOrders.filter((c) => c.state === 'owing').length,
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

  // One matrix cell. A size the product doesn't come in gets a faint
  // dash (distinct from a tinted 0); otherwise each stock line in the
  // column is its own entry, labelled with its raw size only when the
  // cell holds more than one line or sits in Other.
  const matrixCell = (g: StockGroup, col: string) => {
    const lines = g.cells.get(col);
    if (!lines)
      return (
        <td key={col} className="matrix-num">
          <span className="matrix-none" title={`${g.name} doesn't come in ${col}`}>–</span>
        </td>
      );

    const labelled = lines.length > 1 || col === OTHER_COLUMN;
    return (
      <td key={col} className="matrix-num matrix-cell">
        <div className="matrix-stack">
          {lines.map((s) => {
            const cls = `matrix-line matrix-${s.stock_status}${isDimmed(s) ? ' is-dimmed' : ''}`;
            const detail = `${s.name} · ${s.size}: ${s.on_hand} on hand, ${s.committed} owed, ${s.available} available`;
            const content = (
              <>
                {labelled && <span className="matrix-line-size">{s.size}</span>}
                <span className="matrix-line-count">{s.on_hand}</span>
              </>
            );
            return canEditStock ? (
              <button
                key={s.id}
                type="button"
                className={cls}
                title={detail}
                aria-label={`Edit ${detail}`}
                onClick={() => { setEditing(s); setModal('edit'); }}
              >
                {content}
              </button>
            ) : (
              <span key={s.id} className={cls} title={detail}>{content}</span>
            );
          })}
        </div>
      </td>
    );
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
            {isAdmin && (
              <div className="head-actions">
                <button className="btn-mini" disabled={pushing} onClick={pushToWix}>
                  {pushing ? 'Pushing…' : 'Push to Wix now'}
                </button>
                <button className="btn-solid" onClick={() => setModal('item')}>Add item</button>
              </div>
            )}
          </div>

          {pushSummary && (
            <div className="push-summary" role="status">
              <span>{pushSummary}</span>
              <button aria-label="Dismiss" onClick={() => setPushSummary(null)}>×</button>
            </div>
          )}
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
              <option value="oversold">Short</option>
            </select>
          </div>
          {visibleGroups.length === 0 ? (
            <div className="empty">Nothing matches those filters.</div>
          ) : (
            <>
              <div className="matrix-wrap">
                <table className="matrix">
                  <thead>
                    <tr>
                      <th className="matrix-product" scope="col">Product</th>
                      {visibleColumns.map((c) => (
                        <th key={c} className="matrix-num" scope="col">{c}</th>
                      ))}
                      <th className="matrix-num matrix-total" scope="col">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleGroups.map((g) => (
                      <tr key={g.key}>
                        <th className="matrix-product" scope="row">
                          <span className="matrix-name">{g.name}</span>
                          <span className="matrix-meta">
                            {g.category}
                            {g.owed > 0 && (
                              <span
                                className="matrix-owed"
                                title={g.rows
                                  .filter((s) => s.committed > 0)
                                  .map((s) => `${s.size}: ${s.committed}`)
                                  .join(', ')}
                              >
                                {' · '}{g.owed} owed
                              </span>
                            )}
                          </span>
                        </th>
                        {visibleColumns.map((c) => matrixCell(g, c))}
                        <td className={`matrix-num matrix-total${level ? ' is-dimmed' : ''}`}>{g.onHand}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="matrix-legend" aria-hidden="true">
                <span className="matrix-key matrix-ok">In stock</span>
                <span className="matrix-key matrix-low">Low</span>
                <span className="matrix-key matrix-out">None left</span>
                <span className="matrix-key matrix-oversold">Short</span>
                <span className="matrix-key"><span className="matrix-none">–</span> Not made in that size</span>
              </div>
            </>
          )}
        </div>
      )}

      {/* ---------------- Restock ---------------- */}
      {section === 'restock' && (
        <div className="card">
          <div className="card-head">
            <h2>What to order</h2>
            <button onClick={() => {
              const lines = restockOrder
                .flatMap((g) => g.lines.map((l) => `${l.suggested} x ${g.name} — ${l.size}`))
                .join('\n');
              navigator.clipboard.writeText(lines);
              flash('Order list copied.');
            }}>Copy list</button>
          </div>

          <p className="restock-basis">
            Projected from sales in <strong>{season.label}</strong>, the same
            window last season. Suggested order is last season&rsquo;s demand
            less what&rsquo;s available now.
          </p>

          {restockOrder.length === 0 ? (
            <div className="empty">
              Nothing to order. Every size covers last season&rsquo;s demand.
            </div>
          ) : (
            <>
              <table>
                {/* Headings repeat under every product rather than once
                    at the top: the list is long enough that a single
                    header scrolls away, and "Sold last season" vs
                    "Available" vs "Order" are three similar-looking
                    numbers to be guessing at from memory. */}
                {restockOrder.map((g) => (
                  <tbody key={g.name}>
                    <tr className="restock-product">
                      <th colSpan={5} scope="colgroup">{g.name}</th>
                    </tr>
                    <tr className="restock-colheads">
                      <th scope="col">Size</th>
                      <th scope="col" className="num">Sold last season</th>
                      <th scope="col" className="num">Available</th>
                      <th scope="col" className="num">Owed</th>
                      <th scope="col" className="num">Order</th>
                    </tr>
                    {g.lines.map((l) => (
                      <tr key={l.id}>
                        <td>{l.size}</td>
                        <td className="num">
                          {l.demand === null
                            ? <span className="restock-nohistory">No history</span>
                            : l.demand}
                        </td>
                        <td className="num">{l.available}</td>
                        <td className="num">
                          {l.shortfall > 0 ? <span className="pill pill-out">{l.shortfall}</span> : '—'}
                        </td>
                        <td className="num restock-qty">{l.suggested}</td>
                      </tr>
                    ))}
                    <tr className="restock-subtotal">
                      <td colSpan={4}>{g.name} subtotal</td>
                      <td className="num">{g.units} &middot; {money(g.value)}</td>
                    </tr>
                  </tbody>
                ))}
                <tfoot>
                  <tr>
                    <td colSpan={4}>Total to order</td>
                    <td className="num">{restockUnits} units &middot; {money(restockValue)}</td>
                  </tr>
                </tfoot>
              </table>
              <p className="restock-note">
                Owed is shown for context and is not added on top: it is
                already reflected in a negative Available. A line marked
                &ldquo;No history&rdquo; here went on sale after the window, so
                there is nothing to project from &mdash; it is listed because
                orders are owed on it, not because of past demand.
              </p>
            </>
          )}

          {noHistoryCount > 0 && (
            <div className="restock-newblock">
              <button
                className="restock-newblock-head"
                aria-expanded={showNoHistory}
                onClick={() => setShowNoHistory((v) => !v)}
              >
                <span aria-hidden="true">{showNoHistory ? '▾' : '▸'}</span>
                New to the shop &mdash; no sales history yet ({noHistoryCount})
              </button>
              {showNoHistory && (
                <>
                  <p className="restock-note">
                    These went on sale after {season.label}, so last
                    season&rsquo;s figures say nothing about them. They are not
                    a zero &mdash; there is simply nothing to project from.
                    Judge these by eye.
                  </p>
                  <table>
                    {noHistoryGroups.map((g) => (
                      <tbody key={g.name}>
                        <tr className="restock-product">
                          <th colSpan={3} scope="colgroup">{g.name}</th>
                        </tr>
                        <tr className="restock-colheads">
                          <th scope="col">Size</th>
                          <th scope="col" className="num">On hand</th>
                          <th scope="col" className="num">Available</th>
                        </tr>
                        {g.lines.map((l) => (
                          <tr key={l.id}>
                            <td>{l.size}</td>
                            <td className="num">{l.available + l.shortfall}</td>
                            <td className="num">{l.available}</td>
                          </tr>
                        ))}
                      </tbody>
                    ))}
                  </table>
                </>
              )}
            </div>
          )}
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
                <span className="chip-count">{orderCounts[c.key]}</span>
                <span>{c.label}</span>
              </button>
            ))}
          </div>

          <div className="filters">
            <input placeholder="Search by name or email" value={orderSearch} onChange={(e) => setOrderSearch(e.target.value)} />
          </div>

          {/* Both views share one column grid — Name | Qty | Item | Ordered
              | (status) | action | ⋯ — so switching chips doesn't shift
              anything. In Ready, each customer is its own <tbody>: the
              name and "Hand over all" cells span that customer's item
              rows, pinned to the top, and each item keeps its own ⋯. */}
          <table className="orders-table">
            <thead>
              <tr>
                <th className="orders-who">Name</th>
                <th className="orders-qty">Qty</th>
                <th>Item</th>
                <th className="orders-date">Ordered</th>
                {orderChip !== 'ready' && <th>Status</th>}
                <th className="orders-action"><span className="sr-only">Action</span></th>
                <th className="orders-menu"><span className="sr-only">More</span></th>
              </tr>
            </thead>
            {orderChip === 'ready' ? (
              readyGroups.length === 0 ? (
                <tbody>
                  <tr><td colSpan={6}><div className="empty">Nothing ready to hand over.</div></td></tr>
                </tbody>
              ) : readyGroups.map((g) => (
                <tbody className="order-group" key={g.key}>
                  {g.items.map((i, n) => (
                    <tr key={i.id}>
                      {n === 0 && (
                        <td className="orders-who order-group-who" rowSpan={g.items.length}>
                          <strong>{g.name}</strong>
                          <div>{g.email ?? '—'}</div>
                        </td>
                      )}
                      <td className="orders-qty">{i.quantity}</td>
                      <td className="orders-item">{itemLabel(i.stock_items)}</td>
                      {/* Blank when it repeats the row above — a group's
                          items usually share one order date. A different
                          date (the customer ordered twice) still shows. */}
                      <td className="orders-date">
                        {n > 0 && formatDate(g.items[n - 1].ordered_at) === formatDate(i.ordered_at)
                          ? null
                          : formatDate(i.ordered_at)}
                      </td>
                      {n === 0 && (
                        <td className="orders-action order-group-action" rowSpan={g.items.length}>
                          <button className="btn-mini" onClick={() => openHandoverModal(g.items.map((x) => x.id))}>
                            {g.items.length > 1 ? 'Hand over all' : 'Hand over'}
                          </button>
                        </td>
                      )}
                      <td className="orders-menu">
                        <RowMenu
                          actions={[
                            { label: 'Hand over', onClick: () => openHandoverModal([i.id]) },
                            ...(isAdmin ? [{ label: 'Remove', onClick: () => removeOrder(i.id) }] : []),
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))
            ) : (
              <tbody>
                {visibleOrders.length === 0 ? (
                  <tr><td colSpan={7}><div className="empty">No orders match.</div></td></tr>
                ) : visibleOrders.map(({ order: o, state }) => (
                  <tr key={o.id}>
                    <td className="orders-who">
                      <strong>{o.customer_name}</strong>
                      <div>{o.customer_email ?? o.reference}</div>
                    </td>
                    <td className="orders-qty">{o.quantity}</td>
                    <td className="orders-item">{itemLabel(o.stock_items)}</td>
                    <td className="orders-date">{formatDate(o.ordered_at)}</td>
                    <td>
                      {state === 'unpaid' && <span className="pill pill-out">Unpaid</span>}
                      {state === 'owing' && (
                        <>
                          <span className="pill pill-out">Has gear, unpaid</span>
                          {/* Same by/when line as Done: seeing when they
                              took it is the useful bit when chasing. */}
                          <div style={{ fontSize: '0.75rem', color: 'var(--ink-faint)', marginTop: 4 }}>
                            {o.handed_over_by && <>by {o.handed_over_by} </>}
                            {o.distributed_at && <>· {formatDate(o.distributed_at)}</>}
                          </div>
                        </>
                      )}
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
                    <td className="orders-action">
                      {(state === 'unpaid' || state === 'owing') && (
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
                    <td className="orders-menu">
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
            )}
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
