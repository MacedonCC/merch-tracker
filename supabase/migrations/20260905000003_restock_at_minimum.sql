-- ---------------------------------------------------------------
-- migration-003: restock triggers at minimum level
--
-- Depends on migration-002 (applied directly in Supabase, not yet
-- committed to this repo — see MIGRATIONS.md), which is assumed to
-- have added:
--   stock_items.target_level  (integer, default 0)
--   orders.distributed_at     (timestamptz, null until handover)
--
-- committed is not a stored column — it's derived from orders that
-- are paid but not yet handed over (distributed_at is null).
--
-- Replaces stock_overview so that suggested_order is only non-zero
-- when available stock has fallen to or below low_stock_alert, or
-- committed exceeds on-hand quantity. When triggered, suggested_order
-- tops available back up to target_level. Items with target_level = 0
-- never suggest an order.
-- ---------------------------------------------------------------

drop view if exists stock_overview;

create view stock_overview as
  select
    s.id,
    s.name,
    s.category,
    s.size,
    s.price,
    s.quantity as on_hand,
    coalesce(c.committed, 0) as committed,
    (s.quantity - coalesce(c.committed, 0)) as available,
    greatest(coalesce(c.committed, 0) - s.quantity, 0) as shortfall,
    s.low_stock_alert,
    s.low_stock_alert as minimum_level,
    s.target_level,
    s.wix_product_id,
    s.wix_variant_id,
    s.updated_at,
    case
      when (s.quantity - coalesce(c.committed, 0)) < 0 then 'oversold'
      when s.quantity = 0 then 'out'
      when (s.quantity - coalesce(c.committed, 0)) <= s.low_stock_alert then 'low'
      else 'ok'
    end as stock_status,
    case
      when s.target_level = 0 then 0
      when (s.quantity - coalesce(c.committed, 0)) <= s.low_stock_alert
        or coalesce(c.committed, 0) > s.quantity
        then greatest(s.target_level - (s.quantity - coalesce(c.committed, 0)), 0)
      else 0
    end as suggested_order
  from stock_items s
  left join (
    select stock_item_id, sum(quantity) as committed
    from orders
    where payment_status = 'paid'
      and distributed_at is null
    group by stock_item_id
  ) c on c.stock_item_id = s.id;
