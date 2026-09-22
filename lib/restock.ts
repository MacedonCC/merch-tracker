import { sizeRank } from '@/lib/types';

// What to buy for next season, projected from what sold in the last
// completed one.
//
// THIS IS NOT `stock_overview.suggested_order`. That column is the old
// target-level calculation: top back up to `target_level` once
// `available` falls to `low_stock_alert`. It knows nothing about sales
// and nothing about `retired_at`, so it goes on suggesting reorders for
// lines the club has stopped selling - it still proposes three of each
// retired junior shirt size and three of the pre-2026 pants. The
// /restock page stopped reading it; the home page's tile had not, so
// the two screens gave different answers to the same question. This
// module is the single source of that answer.
//
// Both callers pass their own rows in rather than querying here: the
// Stock page already holds everything this needs, and re-reading it
// would put two views of the same data one request apart.

const CLUB_TZ = 'Australia/Melbourne';

// The zone's offset is read from Intl rather than hardcoded, because it
// is not constant across the window: Melbourne is UTC+10 (AEST) on
// 1 August but UTC+11 (AEDT) on 1 March, so a single fixed offset would
// put one end of the window an hour out.

/** Milliseconds to add to a UTC instant to get the club's wall clock. */
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

/** The instant at which the club's wall clock reads this local midnight. */
function clubMidnight(year: number, monthIndex: number, day: number): Date {
  const naive = Date.UTC(year, monthIndex, day);
  // Subtracting the offset at the naive instant lands very close; a
  // second pass corrects the rare case where that first guess falls on
  // the far side of a DST transition.
  const first = naive - clubOffsetMs(naive);
  const second = naive - clubOffsetMs(first);
  return new Date(second);
}

export interface SeasonWindow {
  start: Date;
  end: Date;
  label: string;
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
export function lastSeasonWindow(now = new Date()): SeasonWindow {
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

export interface RestockLine {
  id: string;
  size: string;
  price: number;
  available: number;
  shortfall: number;
  /** null when the line could not have sold in the window at all. */
  demand: number | null;
  suggested: number;
}

export interface RestockGroup {
  name: string;
  lines: RestockLine[];
  units: number;
  value: number;
}

/** The stock fields the projection needs; both callers hold supersets. */
export interface RestockStockRow {
  id: string;
  name: string;
  size: string;
  price: number;
  available: number;
  shortfall: number;
}

/** The order fields the projection needs. */
export interface RestockOrderRow {
  stock_item_id: string | null;
  quantity: number;
  payment_status: string;
  distributed_at: string | null;
  ordered_at: string;
}

export interface RestockProjection {
  season: SeasonWindow;
  /** Every group the projection considered, order and no-history alike. */
  groups: RestockGroup[];
  /** Groups with something to buy, carrying only those lines. */
  order: RestockGroup[];
  /** Groups whose lines could not have sold in the window. */
  noHistory: RestockGroup[];
  units: number;
  value: number;
  /** Individual sizes to buy — what the home page's tile counts. */
  linesToOrder: number;
  noHistoryCount: number;
}

export function projectRestock(input: {
  stock: RestockStockRow[];
  orders: RestockOrderRow[];
  /** stock_items.wix_listed_at, by stock item id. */
  listedAt: Map<string, string | null>;
  /** ids of lines with stock_items.retired_at set. */
  retired: Set<string>;
  now?: Date;
}): RestockProjection {
  const season = lastSeasonWindow(input.now);

  // Demand = units ordered in the window, counting an order once it
  // is either paid or handed over. An order that is neither is an
  // abandoned payment link, and counting it would let someone inflate
  // next season's buy by starting checkouts they never finish.
  const demandById = new Map<string, number>();
  for (const o of input.orders) {
    if (!o.stock_item_id) continue;
    if (o.payment_status !== 'paid' && !o.distributed_at) continue;
    const placed = new Date(o.ordered_at);
    if (placed < season.start || placed >= season.end) continue;
    demandById.set(o.stock_item_id, (demandById.get(o.stock_item_id) ?? 0) + o.quantity);
  }

  const byName = new Map<string, RestockGroup>();
  for (const s of input.stock) {
    // A retired line is finished: it may have sold last season and
    // may even be owed on, but the club no longer buys it, so it has
    // no place on a list of what to order. Its stock, orders and
    // history stay exactly as they are.
    if (input.retired.has(s.id)) continue;
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
    const listed = input.listedAt.get(s.id);
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

  const groups = Array.from(byName.values())
    .map((g) => {
      g.lines.sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
      g.units = g.lines.reduce((n, l) => n + l.suggested, 0);
      g.value = g.lines.reduce((n, l) => n + l.suggested * l.price, 0);
      return g;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // Split: anything to buy goes in the main list; the rest is new stock
  // with no sales history to judge it by.
  const order = groups
    .map((g) => ({ ...g, lines: g.lines.filter((l) => l.suggested > 0) }))
    .filter((g) => g.lines.length > 0)
    .map((g) => ({
      ...g,
      units: g.lines.reduce((n, l) => n + l.suggested, 0),
      value: g.lines.reduce((n, l) => n + l.suggested * l.price, 0),
    }));

  const noHistory = groups
    .map((g) => ({ ...g, lines: g.lines.filter((l) => l.suggested === 0 && l.demand === null) }))
    .filter((g) => g.lines.length > 0);

  return {
    season,
    groups,
    order,
    noHistory,
    units: order.reduce((n, g) => n + g.units, 0),
    value: order.reduce((n, g) => n + g.value, 0),
    linesToOrder: order.reduce((n, g) => n + g.lines.length, 0),
    noHistoryCount: noHistory.reduce((n, g) => n + g.lines.length, 0),
  };
}
