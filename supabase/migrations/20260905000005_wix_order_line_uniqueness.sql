-- ---------------------------------------------------------------
-- migration-005: allow multi-item Wix orders to import one row
-- per line item
--
-- orders.wix_order_id was `unique` on its own, so a Wix order with
-- more than one line item could only ever import its first line —
-- every later line for that same order hit the unique violation and
-- was silently dropped by the sync route.
--
-- Replace the whole-column unique constraint with a partial unique
-- index on (wix_order_id, stock_item_id): a multi-item order can now
-- create one row per line, while re-running the sync still can't
-- create duplicates for the same (order, item) pair. wix_order_id is
-- null for manual orders, so this has to be a partial index (where
-- wix_order_id is not null) rather than a table-level unique
-- constraint, which can't express that condition.
-- ---------------------------------------------------------------

alter table orders drop constraint if exists orders_wix_order_id_key;

drop index if exists orders_wix_order_line_idx;
create unique index orders_wix_order_line_idx
  on orders (wix_order_id, stock_item_id)
  where wix_order_id is not null;
