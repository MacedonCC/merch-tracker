# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Next.js 14 (App Router) app for a sports club committee to track merchandise
stock, orders, payment/handover status, and committee access. Backed by
Supabase (Postgres + Auth), deployed on Vercel, with an hourly cron pulling
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

Both look up the caller by `auth.jwt() ->> 'email'` against `members`, the
same pattern `is_admin()` uses. When adding a new permission-gated field,
extend the relevant trigger — adding it only to the RLS policy won't give
you column granularity.

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
  `wix-inventory`): check a bearer token against `CRON_SECRET`, since there's
  no signed-in user. These are also excluded from the auth middleware
  matcher in `middleware.ts` (`wix-sync` explicitly; the others are hit only
  by Vercel cron/manual calls with the secret).

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
- `stock_status` — `ok | low | out | oversold`.

Stock quantity itself only changes via triggers (`handle_new_order` /
`handle_deleted_order` in `supabase/schema.sql`), fired on `orders`
INSERT/DELETE — never on UPDATE. This is why `wix-sync` sets
`distributed_at` in the same INSERT as the rest of a historical order's row
rather than inserting then updating: an UPDATE wouldn't touch stock (trigger
doesn't fire), but doing it as insert+update would double-deduct via a
different code path. See the long comment at the top of
`app/api/wix-sync/route.ts` before changing order-insert logic.

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

### Wix sync (`app/api/wix-sync/route.ts`)

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

### Route structure

- `app/[section]/page.tsx` — dynamic route for `stock` | `restock` |
  `orders`, all rendered by the same `TrackerSection` client component
  with a `section` prop. Orders (payment status × handover status)
  collapses to four states — unpaid / ready / waiting on stock / done —
  via `classifyOrder()` in `TrackerSection.tsx`; there's no separate
  Handovers route or table column for this, it's derived from
  `payment_status`, `distributed_at`, and the matching stock item's
  `on_hand` every render.
- `app/admin/page.tsx` — committee member management, admin-only (see
  access control above).
- `app/page.tsx` — home tiles (`HomeTiles.tsx`) linking into the sections.
