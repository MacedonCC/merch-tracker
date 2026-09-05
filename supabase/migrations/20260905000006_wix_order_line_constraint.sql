-- ---------------------------------------------------------------
-- migration-006: replace the partial index from migration-005 with
-- a plain unique constraint
--
-- migration-005 added a partial unique index — orders_wix_order_line_idx
-- on (wix_order_id, stock_item_id) where wix_order_id is not null —
-- so manual orders (wix_order_id null) wouldn't collide with each
-- other. That's already applied in Supabase, so it can't be edited;
-- this migration supersedes it instead.
--
-- The problem: the wix-sync route now does a bulk
-- upsert(..., { onConflict: 'wix_order_id,stock_item_id' }). Postgres
-- can only use a partial unique index as an ON CONFLICT arbiter if the
-- ON CONFLICT clause repeats the index's exact WHERE predicate, and
-- Supabase's upsert() has no way to pass that — so the partial index
-- silently can't be used as this upsert's conflict target.
--
-- A plain (non-partial) unique constraint doesn't have that
-- restriction, and doesn't need partiality to protect manual orders
-- either: standard multi-column unique constraints already treat
-- NULL as never equal to NULL, so rows with wix_order_id null never
-- conflict with each other regardless.
-- ---------------------------------------------------------------

drop index if exists orders_wix_order_line_idx;

alter table orders drop constraint if exists orders_wix_order_line_key;
alter table orders
  add constraint orders_wix_order_line_key unique (wix_order_id, stock_item_id);
