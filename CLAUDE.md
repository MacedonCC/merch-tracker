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

## Architecture

### Auth and access control — two independent layers

- `middleware.ts` redirects unauthenticated visitors to `/login` for every
  route except `/login` and `/auth/*`. This is a UX convenience, not a
  security boundary.
- Actual access control is `members` table membership + `role` column
  (`admin` | `helper`), enforced two ways:
  - **Postgres RLS**, via `is_committee_member()` / `is_admin()` SQL
    functions (see `supabase/migrations/20260905000004_member_roles_and_rls.sql`).
  - **Server-side role checks** in API routes that use the service-role
    client and therefore bypass RLS — e.g. `app/api/members/route.ts` calls
    `resolveViewer()` (`lib/member.ts`) and rejects non-admins before doing
    anything. Never rely on a page/route being unreachable through the UI as
    the only access control — routes using `createAdminSupabase()` must
    check the caller's role themselves.
- A signed-in user with no `members` row is not an error state — they see
  `NotOnCommitteeList`, not a redirect.

### Two Supabase clients (`lib/supabase-server.ts`)

- `createServerSupabase()` — cookie-bound, anon key, subject to RLS. Used
  for reading data as the signed-in user.
- `createAdminSupabase()` — service-role key, bypasses RLS. Used for
  privileged operations (member invite/removal, Wix sync/import) and always
  paired with a manual auth check first.
- Both force `cache: 'no-store'` on every fetch (`noStoreFetch`). This was a
  deliberate fix for stale reads: Next.js's Data Cache can cache
  `supabase-js`'s internal fetches even on `force-dynamic` routes, so a
  request can silently return an outdated row count. Don't remove this.
- `lib/supabase-client.ts` is the browser client (anon key) used by client
  components for direct reads/writes that RLS is expected to police (e.g.
  `TrackerSection.tsx`, `AdminPanel.tsx`'s role toggle).

### Route protection patterns

Two different auth patterns are used depending on who calls the route:

- **Committee/admin actions** (`app/api/members/*`): check the signed-in
  user via `resolveViewer()` + role, using the cookie-bound client.
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

- `app/[section]/page.tsx` — dynamic route for `stock` | `handovers` |
  `restock` | `orders`, all rendered by the same `TrackerSection` client
  component with a `section` prop.
- `app/admin/page.tsx` — committee member management, admin-only (see
  access control above).
- `app/page.tsx` — home tiles (`HomeTiles.tsx`) linking into the sections.
