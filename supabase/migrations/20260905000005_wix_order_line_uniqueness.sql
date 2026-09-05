-- ---------------------------------------------------------------
-- migration-005: allow multi-item Wix orders to import one row
-- per line item
--
-- orders.wix_order_id was `unique` on its own, so a Wix order with
-- more than one line item could only ever import its first line —
-- every later line for that same order hit the unique violation and
-- was silently dropped by the sync route.
--
-- Replace the whole-column unique constraint with a unique
-- constraint on (wix_order_id, stock_item_id): a multi-item order
-- can now create one row per line, while re-running the sync still
-- can't create duplicates for the same (order, item) pair.
--
-- This is a plain (non-partial) constraint, not a partial index
-- filtered on "wix_order_id is not null". Two reasons that's fine
-- and actually preferable here:
--   1. Standard multi-column unique constraints already tolerate
--      NULLs the way we need: a row only conflicts with another if
--      EVERY constrained column matches, and NULL never equals
--      NULL. So manual orders (wix_order_id null) never collide
--      with each other or with Wix rows, with no partial predicate
--      required.
--   2. The sync route does a bulk `upsert(..., { onConflict:
--      'wix_order_id,stock_item_id' })`. Postgres can only use a
--      partial unique index as an ON CONFLICT arbiter if the
--      ON CONFLICT clause repeats its exact WHERE predicate —
--      Supabase's upsert() has no way to pass that, so a partial
--      index silently can't be targeted this way. A plain
--      constraint has no such restriction.
-- ---------------------------------------------------------------

alter table orders drop constraint if exists orders_wix_order_id_key;

drop index if exists orders_wix_order_line_idx;

alter table orders drop constraint if exists orders_wix_order_line_key;
alter table orders
  add constraint orders_wix_order_line_key unique (wix_order_id, stock_item_id);
