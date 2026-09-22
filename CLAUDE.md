# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Next.js 14 (App Router) app for a sports club committee to track merchandise
stock, orders, payment/handover status, and committee access. Backed by
Supabase (Postgres + Auth), deployed on Vercel, with a daily cron pulling
paid orders from a Wix store.

## Commands

```bash
npm run dev      # local dev server, http://localhost:3000
npm run build    # production build (also runs type-checking + lint)
npm run lint     # next lint
npx tsc --noEmit # type-check only, faster than a full build
```

There is no test suite in this repo.

## Working conventions

- Run `npx tsc --noEmit` before every commit.
- Always commit and push once a change is complete, without waiting to be
  asked.
- Never edit a migration file that has already been applied — write a new
  migration instead (see Schema drift below).
- After writing a migration, run `supabase db push` to apply it, then
  commit and push. Don't wait to be asked.

## Architecture

### Auth and access control — two independent layers

- `middleware.ts` redirects unauthenticated visitors to `/login` for every
  route except `/login` and `/auth/*`. This is a UX convenience, not a
  security boundary.
- The matcher must also exclude public static assets (images, icons —
  currently done by extension in `config.matcher`, not just the literal
  `favicon.ico`). This isn't just tidiness: Vercel's Image Optimization
  fetches a "local" `/public` asset with an uncookied HTTP request back
  to this same deployment, so if that path isn't excluded, an
  unauthenticated fetch for it gets redirected to `/login` like any
  other protected route — the optimizer then has nothing to transform
  and the image comes back broken in the browser. This only ever showed
  up on `/login` itself (the club logo), since that's the one page an
  unauthenticated visitor — and so an uncookied asset fetch — ever
  loads; every other page's images are fetched by an already-signed-in
  session. Any new file added to `public/` needs its extension covered
  by the matcher, or to be added explicitly.
- Actual access control is `members` table membership + `role` column
  (`admin` | `helper`), enforced two ways:
  - **Postgres RLS**, via `is_committee_member()` / `is_admin()` SQL
    functions (see `supabase/migrations/20260905000004_member_roles_and_rls.sql`).
  - **Server-side role checks** in API routes that use the service-role
    client and therefore bypass RLS — e.g. `app/api/members/route.ts` calls
    `requireAdmin()` (`lib/member.ts`) and rejects non-admins before doing
    anything. Never rely on a page/route being unreachable through the UI as
    the only access control — routes using `createAdminSupabase()` must
    check the caller's role themselves.
- A signed-in user with no `members` row is not an error state — they see
  `NotOnCommitteeList`, not a redirect.
- The admin page is reachable only from the avatar menu (`Header.tsx`),
  which only renders that link for admins — there's no nav-bar entry. This
  is the same "UI hiding is not access control" caveat as above: `/admin`
  itself re-checks `role === 'admin'` server-side and redirects otherwise.

### Permission model — helpers can hold four fine-grained flags

Beyond `admin` / `helper`, a helper can be granted any combination of
`can_adjust_stock`, `can_change_prices`, `can_change_targets`,
`can_undo_handover` (columns on `members`, added in
`supabase/migrations/20260906000001_permissions_and_invitations.sql`).
Admins have all four implicitly regardless of the column values — that
rule lives in exactly one place, `effectivePermissions()` in
`lib/member.ts`, and both `TrackerSection.tsx` (to hide/disable controls)
and `app/[section]/page.tsx` (to compute the `permissions` prop) go
through it. Never read the raw `member.can_*` columns directly in UI code.

Row-level security can only gate whole rows, not individual columns, so
the column-level rules are enforced by two `BEFORE UPDATE` trigger
functions, not by the RLS policy itself:
- `check_stock_item_update()` on `stock_items` — compares `OLD`/`NEW` and
  raises unless the changed column's permission is held (or the caller is
  admin). Also blocks helpers from touching item identity fields (name,
  category, size, Wix linking) entirely.
- `check_order_update()` on `orders` — blocks clearing `distributed_at`
  (undoing a handover) without `can_undo_handover`.

Deleting an order (the Orders page's "Remove", tucked behind an
admin-only `...` row menu — see `RowMenu` in `TrackerSection.tsx`) is
plain row-level, not column-level, so it's just an RLS policy rather
than a trigger: `supabase/migrations/20260906000002_admin_only_order_delete.sql`
split the old single "orders full access" policy into separate
select/insert/update policies open to any committee member and a
delete policy gated on `is_admin()`.

`orders.handed_over_by` / `handover_note` (both nullable,
`supabase/migrations/20260906000003_handover_details.sql`) are only
ever written together with `distributed_at` — `TrackerSection.tsx`'s
handover modal (opened by "Hand over", "Hand over all", and "Edit
handover" on a Done row) sets all three at once, and `undoHandover()`
clears all three at once. Neither has its own trigger: setting them
alongside a non-null `distributed_at` (fresh handover or a correction)
needs no permission, same as `check_order_update()` already allows;
only clearing `distributed_at` back to null is gated.

Both look up the caller by `auth.jwt() ->> 'email'` against `members`, the
same pattern `is_admin()` uses. When adding a new permission-gated field,
extend the relevant trigger — adding it only to the RLS policy won't give
you column granularity.

One deliberate hole in `check_stock_item_update()`, added in
`supabase/migrations/20260920000003_handover_stock_permission.sql`:
handing over an order deducts stock via `handle_distribution_change()`,
whose inner `update stock_items` fires `check_stock_item_update()` and
used to demand `can_adjust_stock`. `SECURITY DEFINER` does not help —
it changes the role, but `auth.jwt()` still resolves to the signed-in
member, so every helper (all of whom have `can_adjust_stock = false`)
was blocked from handing anything over at all. The order triggers now
set a transaction-local `app.order_stock_change` flag around their stock
writes, and `check_stock_item_update()` returns early when it is set.
`can_adjust_stock` still gates editing a count by hand; this only
exempts the automatic consequence of a handover the member was already
entitled to perform. The flag is cleared immediately after each write
and cannot be set through PostgREST.

### Invitations — how a person actually gets committee access

`invitations` (same migration as above) records an offer: email, role,
the four permission flags, `invited_by`, `invited_at`, `expires_at` (7
days), `status` (`pending` | `accepted` | `revoked`). Creating one
(`POST /api/invitations`) does **not** create a `members` row — it never
has enough to bypass RLS's admin-only insert intentionally. The row only
gets created when the invitee actually signs in: `app/auth/callback/route.ts`
looks for a pending, unexpired invitation matching the signed-in email
and, if found, inserts the `members` row from it (service-role client)
and marks the invitation `accepted`. This means:
- Re-inviting an email that hasn't accepted yet is always safe (no
  members row exists yet to conflict with).
- An admin using **Add directly** (`POST /api/members`) skips invitations
  entirely and creates the row immediately — for fixing a role or
  adopting an auth user that already exists outside this flow.
- `invitations` has no `full_name` column; a name entered on the invite
  form rides along in the auth user's `user_metadata.full_name` (set via
  `inviteUserByEmail`'s `data` option) and is read back in the callback
  when the `members` row is finally created.

### Two Supabase clients (`lib/supabase-server.ts`)

- `createServerSupabase()` — cookie-bound, anon key, subject to RLS. Used
  for reading data as the signed-in user.
- `createAdminSupabase()` — service-role key, bypasses RLS. Used for
  privileged operations (member invite/removal, Wix sync/import) and always
  paired with a manual auth check first.
- Both force `cache: 'no-store'` on every fetch, via the shared
  `noStoreFetch` helper in `lib/no-store-fetch.ts`. This was a deliberate
  fix for stale reads: Next.js's Data Cache can cache `supabase-js`'s
  internal fetches even on `force-dynamic` routes or in Middleware, so a
  request can silently return stale data — a wix-sync run once
  under-reported stock, and separately `middleware.ts`'s own
  `getUser()` call (it builds its own client rather than reusing this
  file, since `next/headers`'s `cookies()` isn't available in
  Middleware) was missing this, so a cached "no session" response could
  outlive an actual sign-in and bounce a freshly authenticated user back
  to `/login`. Any new Supabase client construction — including
  Middleware's — needs `global: { fetch: noStoreFetch }`, not just the
  two clients in this file.
- `lib/supabase-client.ts` is the browser client (anon key) used by client
  components for direct reads/writes that RLS (and the triggers below) are
  expected to police — e.g. `TrackerSection.tsx`'s stock/order edits.
  `AdminPanel.tsx` instead goes through the `app/api/members` and
  `app/api/invitations` routes for everything, since those need the
  service-role client (to invite/delete auth users) and a hand-rolled
  admin check either way.

### Route protection patterns

Two different auth patterns are used depending on who calls the route:

- **Committee/admin actions** (`app/api/members/*`, `app/api/invitations/*`):
  check the signed-in user via `requireAdmin()` (`lib/member.ts`), using the
  cookie-bound client, before doing anything with the service-role client.
- **Cron/webhook-style routes** (`app/api/wix-sync`, `wix-import`,
  `wix-media`): check a bearer token against `CRON_SECRET`, since
  there's no signed-in user.

**The cron runs once a day at 09:00 UTC** (`vercel.json`:
`"0 9 * * *"`). Vercel schedules crons in UTC, never in the project's
local time, so at the club that is **7pm during AEST and 8pm during
AEDT** — it shifts an hour when daylight saving starts and ends. It is
not hourly, whatever older notes said. `/api/wix-sync` is the only
scheduled route; `wix-import` and `wix-media` are run by hand.

The daily Wix availability push piggybacks on the end of that same
run (see `lib/wix-push.ts`), so it inherits the same time and, more
importantly, the same ordering: the day's orders are imported before
anything is pushed. **Import-then-push is a rule for every caller, not
a property of the cron.** `available` is `on_hand - committed` and
`committed` only counts orders we already hold, so between a Wix sale
and the import our `available` is stale-*high*; pushing in that window
raises Wix's count and re-offers a garment that has just been bought.
That is why the import lives in `lib/wix-sync-run.ts` (`runWixSync()`)
rather than inside the route: `app/api/wix-sync` (the cron) and the
POST half of `app/api/wix-push` (the "Push to Wix now" button on the
Stock page, which an admin can press at any hour) both call it
immediately before pushing. The button's GET preview does not import —
it stays a pure read — so its figures can read slightly high, which the
confirm dialog states and the result message corrects by reporting what
the import actually brought in. A failed import aborts the push rather
than pushing on figures known to be stale.

`wix-inventory` is **retired** and answers 410 — the tracker is the
source of truth for stock, and `check_stock_item_update` refused its
writes anyway.

**Wix inventory tracking is now ON for the whole catalogue.** An older
note here said it was off for almost all of it; that was true when it
was written and is no longer. Checked 22 Sep 2026 against
`wix-import`'s `wixStock`: all 16 merchandise products come back
`trackQuantity: true`. Do not reason from the old claim — the reasons
`wix-inventory` is retired never depended on it.

What tracking does *not* mean is that Wix holds a figure for every
size. 15 of 103 catalogue sizes have **no inventory record at all**
for their variant, reported as `wixQuantity: null` with
`wixTracked: true` — "Wix did not say", which is not the same as
"Wix says none". They cluster in never-stocked sizes (4XL, JNR16) and
Wix appears to create a variant's record only once a quantity has been
set for it, including to zero; other zero-availability sizes do have a
0 record. A push does **not** skip them: `pushAvailableToWix` finds no
`current` variant, records `previousQuantity: null`, and still sends
the variant in the PATCH. At the time of checking all 15 had
`max(0, available) = 0`, so a push would write 0 to each and change
nothing a customer can buy — but it would count all 15 as
`wouldChange` on that first run, since `null !== 0`, and settle
afterwards.

**`middleware.ts` excludes all of `api/` from the matcher, and must keep
doing so.** Middleware redirects an unauthenticated request to `/login`,
which is meaningless for an API caller and — crucially — happens
*before* the route runs, so a `CRON_SECRET` bearer token never gets
looked at. Only `api/wix-sync` was excluded originally, so `wix-import`,
`wix-inventory` and `wix-media` answered `307 -> /login` to every
external call and were unreachable; `wix-sync` was excluded, which is
the only reason the daily cron kept working. This is safe precisely
because of the rule above: every API route authenticates itself, so
middleware was never their security boundary.

### Stock model — `stock_overview` is the source of truth for quantities

`stock_items.quantity` is the raw on-hand count, but almost nothing reads it
directly. The `stock_overview` view (redefined in
`supabase/migrations/20260905000003_restock_at_minimum.sql`, **not** in
`supabase/schema.sql` which is stale — see below) derives the fields the UI
actually uses:

- `on_hand` — raw quantity.
- `committed` — sum of paid-but-not-yet-handed-over order quantities.
- `available` — `on_hand - committed`.
- `suggested_order` — non-zero only once `available` drops to
  `low_stock_alert` or stock is oversold, topping back up to `target_level`.
  Items with `target_level = 0` never suggest an order.
  **The `/restock` page no longer reads this field.** It projects demand
  from sales in the most recently **completed** Aug–Feb season (never
  one still running, which would under-project every line), with
  midnight pinned to Australia/Melbourne regardless of device timezone
  and a half-open upper bound so 28 Feb isn't dropped. It suggests
  `max(0, demand − available)`. `target_level` and this column both stay
  in place for the Stock page; restock simply stopped using them.
  Two traps in that formula: `shortfall` equals `−available` whenever
  stock is oversold, so adding both double-counts the oversold units —
  it is displayed but never added. And an order counts toward demand
  once it is paid *or* handed over, so an abandoned payment link cannot
  inflate next season's buy.
  "No history" is decided by **`stock_items.wix_listed_at`**, not by
  whether a line is linked to Wix. A line listed after the window began
  could not have sold during it. The old proxy (`wix_product_id IS
  NULL`) collapsed twice over: `wix-sync`'s name+size fallback can match
  an unlinked row, and a catalogue import linked 39 lines at once, which
  made every one of them read as having sold nothing last season. Real
  sales always take precedence over the label — a line that sold was
  self-evidently on sale.
  `wix_listed_at` is stamped by `wix-import` when it first links or
  creates a line and **never changed after**, which
  `check_stock_item_update` enforces rather than leaving to the route.
  Re-stamping would make an old line look new and erase its history.
  No-history lines with nothing to buy sit in a collapsed "New to the
  shop" block below the order list; one with a shortfall stays in the
  main list, because owed stock is a real obligation however new the
  line is.
  **Lines with `stock_items.retired_at` set are skipped entirely.** The
  retired pre-2026 pants line still had 2 units of demand in last
  season's window and was duly suggesting the club buy two more of a
  product it no longer sells. Retirement could not be inferred from the
  absence of a Wix link — an unlinked line may simply never have been
  in the online shop while still being sold at the ground — so it is an
  explicit column, admin-only, and never settable by a catalogue
  import. Stock, orders and history on a retired line are untouched.
  `stock_items.created_at` is identical on every row (the date this
  repo's migrations first ran), so it cannot tell you when a line became
  sellable and must not be used for this.
  The window's offset is read from `Intl` per boundary, not hardcoded:
  Melbourne is UTC+10 on 1 Aug but UTC+11 on 1 Mar, so one fixed offset
  would put an end of the window an hour out. Which season it is gets
  judged on the club's clock too — a device set to UTC is still 31 July
  when it is already August at the ground.
  Which season counts as "completed" depends on the month: Jan–Feb
  reaches back an extra year because the season that began last August
  is still running, while Mar–Jul and Aug–Dec both land on the season
  that began last August. Mar–Jul is the easy one to get wrong — it is
  the tail of the calendar year but the season has already finished.
- `stock_status` — `ok | low | out | oversold`.

Stock quantity itself only changes via two triggers on `orders`, and
**neither fires on INSERT** — stock moves on handover, not on sale
(moved there in migration-002, which isn't in this repo; see
`supabase/MIGRATIONS.md`). `supabase/schema.sql` still shows the
original INSERT/DELETE pair and is wrong about this, like the rest of
its drift:

- `on_distribution_change` (AFTER UPDATE, `handle_distribution_change`)
  deducts when `distributed_at` goes null → not-null, using
  `quantity = greatest(0, quantity - new.quantity)` so it clamps at zero
  rather than going negative, and adds the quantity back on the reverse
  transition. It writes its own `stock_movements` row either way.
- `on_order_removed` (AFTER DELETE, `handle_order_removed`) restores
  stock only if the deleted order had already been handed over.

This is why `wix-sync` sets `distributed_at` in the same INSERT as the
rest of a historical order's row rather than inserting then updating: an
INSERT fires no trigger at all, so an already-fulfilled order is recorded
as handed over without deducting stock, whereas insert-then-update would
fire `on_distribution_change` and wrongly deduct it. See the long comment
at the top of `app/api/wix-sync/route.ts` before changing order-insert
logic.

One gotcha for maintenance scripts: `check_order_update` (BEFORE UPDATE)
resolves the caller with `auth.jwt() ->> 'email'` and raises
`Not authorised to update orders.` when there is no JWT at all. Any bulk
update run as plain SQL (`supabase db query`, psql) must therefore
`set_config('request.jwt.claims', '{"email":"<an admin>"}', true)` inside
the transaction first, or every row aborts — this is separate from, and
additional to, disabling `on_distribution_change` when a backfill must not
move stock.

Every stock change is logged to `stock_movements` — treat it as the audit
trail when a quantity looks wrong, rather than reasoning from `stock_items`
alone.

### Schema drift — read migrations, not just `schema.sql`

`supabase/schema.sql` is the original bootstrap script and is **out of
date**: migrations 002 and 003 (target levels, `distributed_at`,
`stock_overview` reshaping) were applied directly in Supabase before this
repo tracked migrations, and are not reflected there. `supabase/MIGRATIONS.md`
records this gap. When the actual shape of a table/view matters, check
`supabase/migrations/*.sql` (numbered, applied in order) over `schema.sql`.
Also: never edit a migration file that has already been applied — Supabase
won't re-run it, so editing it in place only desyncs the repo from the live
database (this happened once; migration-006 exists to correct migration-005
rather than editing it). Write a new migration instead.

### Wix catalogue import (`app/api/wix-import/route.ts`)

Reconciles the Wix catalogue against `stock_items`: links existing lines
to their Wix product/variant, brings prices across, and creates a line
at `quantity 0` for any Wix size the tracker lacks. **`?dryRun=1`
writes nothing and returns the identical report — always run that
first.**

It never writes `quantity` on a row that already exists. The original
version upserted on `(name, size)` with `quantity: 0` in the payload,
which on a match would have zeroed the real cupboard count. That is now
structurally impossible, not merely avoided: migration
`20260920000007` lets a service-role caller through
`check_stock_item_update` for `image_url`, `wix_product_url`,
`wix_product_id`, `wix_variant_id` and `price` only, so an update
carrying `quantity` — even bundled with an allowed column — is refused
by the database.

A created line's category comes from `guessCategory()`, which matches
on words in the product name and is only ever consulted for a line
being **created** — it never reclassifies an existing row. Shorts is
matched as `/shorts/`, the plural as a whole word: a substring
test for "short" read "Juniors Coloured Playing Shirts Short Sleeve
(Unisex)" as Shorts, because the garment is named for its sleeves.
Testing `shirt` before `short` would fix that one name and break the
next product that mentions both.

Matching is by name + size via `nameSizeKey()` in `lib/types.ts`, shared
with `wix-sync`'s fallback so the two cannot drift. A size that imports
under one spelling and syncs under another would create a line that
silently never receives orders.

The report also carries **`wixStock`**: every Wix catalogue size with
the quantity Wix holds for it (from a second read, the same
`/stores/v2/inventoryItems/query` that `lib/wix-push.ts` uses),
alongside the tracker's own `on_hand`. It is built in its own
read-only pass rather than through `findRow()`, which consumes a row
as it matches — a report must not change what the import then does.
Because of that it covers products the tracker has **no line for yet**,
which is the point: a brand new Wix product cannot be looked up any
other way until a line exists for it, and those rows come back with
`trackerLine: null`.

`wixQuantity: null` with `wixTracked: false` means Wix is not counting
that product at all, which is not the same as zero. A failed inventory
read sets `wixStockError` and leaves the quantities null rather than
failing the import — linking and prices are the job, quantities are
commentary. **Nothing reads `wixStock` back.** It is a report, not a
stock feed; migration `20260920000007` would refuse a quantity write
from this route regardless. Making a Wix count into the tracker's
count is a deliberate act with a `stock_movements` row behind it.

### Wix sync (`lib/wix-sync-run.ts`, routed by `app/api/wix-sync/route.ts`)

The route is a thin wrapper: authenticate on `CRON_SECRET`, call
`runWixSync()`, then push. All the import logic is in the lib, which
never pushes — see the ordering rule under Route protection patterns.

Pulls the full paid-order history from Wix (no lookback window, so it's
always safe to re-run to catch up on anything missed). Matching a Wix line
item to a `stock_items` row is by `wix_product_id`/`wix_variant_id`
(admin sets this per item via "Adjust" in the UI); unmatched lines are
reported back rather than silently dropped. Dedup key for re-running is
`(wix_order_id, stock_item_id)`, not `wix_order_id` alone, because one Wix
order can import as several rows (one per line item). Designed to do a
constant number of Supabase calls regardless of import size — read existing
keys, read stock list, one bulk upsert — with matching/deduping done in
memory; keep that shape when touching it.

### The quick-sale flow (`/sell`)

`app/sell/page.tsx` + `components/SellFlow.tsx` — a single-screen,
mobile-first flow for selling at the ground: product grid → size chips →
customer (type-ahead over distinct `orders.customer_name`) → cash or
payment link. Any committee member can use it; there is no extra
permission gate.

Two things about it are load-bearing:

- **A cash sale is two writes, not one.** The order is INSERTed with
  `distributed_at` null, then immediately UPDATEd to set it. That is not
  redundant: stock only moves on UPDATE (see the trigger section above),
  so inserting with `distributed_at` already set would hand the garment
  over without ever reducing stock. This is the mirror image of the
  `wix-sync` rule, which needs the opposite shape for the opposite
  reason. Verified against the live database: after the INSERT the count
  is unchanged, after the UPDATE it drops by one.
- **A back-order is never handed over.** Sizes with `available <= 0` stay
  sellable, but only the INSERT runs — no `distributed_at`, no stock
  movement — because there is nothing in the cupboard to give. The
  confirmation screen switches colour and spells out that the item is
  owed, so a coach mid-queue cannot misread it as complete.
- **The payment-link path asks "are they taking it now?"** Taking it now
  writes the order unpaid *and* hands it over (same two-write pattern as
  cash, so stock drops); collecting later writes it unpaid and leaves
  stock alone. The question is skipped entirely on a back-order, where
  there is nothing to take. Taking it now is what creates the
  unpaid-but-handed-over combination described under Route structure.

`stock_items.image_url` / `wix_product_url` (migration
`20260920000002_sell_flow.sql`) feed the product grid and the "send
payment link" button, and are populated from the Wix catalogue by
`app/api/wix-media/route.ts`, keyed on `wix_product_id`. Both are
nullable: an unlinked item falls back to a lettered tile and offers no
link. These are Wix shop product pages, **not** PlayHQ links — PlayHQ is
registration, not merchandise.

`orders.payment_method` is `cash | online | unknown`. Historical rows
default to `unknown`; every Wix row is `online` (backfilled, and set on
import).

**The payment-link email** (`app/api/send-payment-link/route.ts`,
template in `lib/payment-link-email.ts`) goes out over Gmail SMTP via
nodemailer, using `GMAIL_USER` / `GMAIL_APP_PASSWORD`. Four things about
it are deliberate:

- It runs **after** the order is already written, and never returns a
  non-2xx for a send failure — it answers `{ sent: false, reason }` so
  the UI can say "saved, but the email didn't send" and offer the link
  to copy. A sale must never be lost because SMTP was down.
- It re-reads the order and stock item **from the database by id**
  rather than trusting the product, size or price the browser posted.
- The logo is attached by CID, not linked, since most clients block
  remote images. `public/` is served by the CDN and is not otherwise
  traced into the serverless bundle, so `next.config.js` names it in
  `experimental.outputFileTracingIncludes` for this route. The read is
  still best-effort: a miss drops the logo, not the email.
- The copy must **not** say the item is reserved. A payment-link sale is
  `pending`, and `stock_overview` counts only `paid` orders as
  `committed`, so nothing is actually held and another coach can sell
  the last one. Saying otherwise would be a promise the schema does not
  keep — changing that would mean counting pending orders in
  `committed`, which moves `available`, `stock_status` and
  `suggested_order` everywhere.

Auth follows the committee-action pattern (cookie-bound client,
`getCurrentMember()`), not the `CRON_SECRET` pattern — it is triggered
by a signed-in coach — and it is deliberately not admin-only.

### Route structure

- `app/[section]/page.tsx` — dynamic route for `stock` | `restock` |
  `orders`, all rendered by the same `TrackerSection` client component
  with a `section` prop. Orders (payment status × handover status)
  collapses to five states — unpaid / has gear, unpaid / ready / waiting
  on stock / done —
  via `classifyOrders()` in `TrackerSection.tsx`; there's no separate
  Handovers route or table column for this, it's derived from
  `payment_status`, `distributed_at`, and the matching stock item's
  `on_hand` every render. **`classifyOrder()` tests payment before
  handover, and that order is load-bearing**: it used to check
  `distributed_at` first and return `done`, which filed an
  unpaid-but-handed-over order under "nothing to do" — exactly the debt
  worth chasing. Nothing could produce that combination until `/sell`
  grew its "taking it now" option, so it never appeared in the data;
  it would have the moment that shipped. `refunded` counts as not paid,
  so a refunded, handed-over order reads as owing rather than done.
  **Ready vs waiting is a queue, not a per-row test.** Stock is
  allocated oldest order first, so an order is Ready only if enough is
  on hand *after every earlier order for the same size* has taken its
  share. This is why the whole list is classified in one pass rather
  than each row independently: the old per-row version asked "is there
  enough for this order?" and answered yes for two orders sharing one
  garment. "Hand over all" needs no separate rule — it is built from
  rows already classified Ready.
- `app/admin/page.tsx` — committee member management, admin-only (see
  access control above).
- `app/page.tsx` — home tiles (`HomeTiles.tsx`) linking into the sections.
