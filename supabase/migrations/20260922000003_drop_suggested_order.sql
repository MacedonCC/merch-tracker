-- Drop suggested_order from stock_overview. Nothing reads it any more.
--
-- It was the original restock rule: once `available` fell to
-- `low_stock_alert`, top back up to `target_level`. That rule knows
-- nothing about what actually sold and nothing about `retired_at`, so
-- it went on proposing three of each retired junior shirt size and
-- three of the pre-2026 pants. /restock replaced it with a projection
-- from last season's sales and stopped reading the column; the home
-- page's "lines to reorder" tile was the last reader and moved to the
-- same projection (`projectRestock()` in lib/restock.ts), which is
-- what finally makes this safe to remove. The two disagreed badly
-- while both existed - 59 lines against 30.
--
-- `target_level` KEEPS ITS COLUMN on stock_items. The app stops
-- writing it in the same change as this migration, and the Adjust
-- modal's "Target to hold" field is gone, but the numbers the
-- committee has already entered are history and dropping the column
-- would burn them. The column is simply no longer read or written by
-- anything. The view still exposes it for the same reason.
--
-- `low_stock_alert` is untouched and still load-bearing: it decides
-- `stock_status`, which is what colours the Stock grid. Only the
-- second CASE below goes.
--
-- WHY DROP AND RECREATE rather than CREATE OR REPLACE: Postgres will
-- not let CREATE OR REPLACE VIEW remove a column, only add to the end
-- of the list. Checked before writing this: no other view, rule or
-- policy depends on stock_overview, so the drop takes nothing with it.
--
-- The two properties a recreate silently loses, both restored below:
--   security_invoker = on — without it the view runs as its owner and
--     stops applying the caller's RLS, quietly widening what a signed
--     in member can read.
--   the grants to anon / authenticated / service_role — without them
--     PostgREST answers permission denied for every caller, which is
--     every page in the app.

drop view if exists stock_overview;

create view stock_overview
with (security_invoker = on) as
  select
    s.id,
    s.name,
    s.category,
    s.size,
    s.price,
    s.quantity as on_hand,
    coalesce(c.committed, 0::bigint) as committed,
    s.quantity - coalesce(c.committed, 0::bigint) as available,
    greatest(coalesce(c.committed, 0::bigint) - s.quantity, 0::bigint) as shortfall,
    s.low_stock_alert,
    s.low_stock_alert as minimum_level,
    s.target_level,
    s.wix_product_id,
    s.wix_variant_id,
    s.updated_at,
    case
      when (s.quantity - coalesce(c.committed, 0::bigint)) < 0 then 'oversold'::text
      when s.quantity = 0 then 'out'::text
      when (s.quantity - coalesce(c.committed, 0::bigint)) <= s.low_stock_alert then 'low'::text
      else 'ok'::text
    end as stock_status
  from stock_items s
  left join (
    select orders.stock_item_id, sum(orders.quantity) as committed
      from orders
     where orders.payment_status = 'paid'::text
       and orders.distributed_at is null
     group by orders.stock_item_id
  ) c on c.stock_item_id = s.id;

comment on view stock_overview is
  'Per-size stock with committed/available derived from paid, un-handed-over orders. suggested_order was removed on 22 Sep 2026: what to buy is projected from last season''s sales in lib/restock.ts, not from target_level.';

grant select, insert, update, delete, truncate, references, trigger
  on stock_overview to anon, authenticated, service_role;
