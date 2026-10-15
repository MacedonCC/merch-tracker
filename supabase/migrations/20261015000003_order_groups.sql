-- Juniors / Seniors split on orders, because two different people
-- manage handovers. A label only: nothing about stock, payment or
-- handover reads it.
--
-- `order_group` rather than `group`, which is a reserved word in SQL.
-- Null means unassigned, and the Orders page counts those so they get
-- sorted.
--
-- Any committee member can change it. The orders update RLS policy is
-- already open to every committee member and check_order_update() only
-- polices handover columns, so no trigger change is needed.
--
-- DEFAULT FOR NEW ORDERS: a BEFORE INSERT trigger sets juniors for a JNR
-- size when the insert did not choose a group; everything else stays
-- unassigned. One place covers wix-sync, Add order and /sell (which
-- always sends its own choice, so the trigger leaves it alone). It
-- touches nothing but order_group: the "no INSERT trigger moves stock"
-- rule still holds. merge_payment_link_order() never writes the column,
-- so a merged order keeps the /sell order's group.

alter table orders
  add column if not exists order_group text
  check (order_group in ('juniors', 'seniors'));

comment on column orders.order_group is
  'Who manages this order''s handover: juniors, seniors, or null (unassigned). Display and filtering only.';

create or replace function set_default_order_group()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.order_group is null and new.stock_item_id is not null then
    if exists (select 1 from stock_items where id = new.stock_item_id and size ilike 'JNR%') then
      new.order_group := 'juniors';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists set_default_order_group on orders;
create trigger set_default_order_group
  before insert on orders
  for each row execute function set_default_order_group();

-- Backfill open orders only (anything not paid-and-handed-over) with the
-- same rule. Done orders stay unassigned. check_order_update() needs a
-- caller on every UPDATE, so this runs as an admin; distributed_at is
-- not touched, so on_distribution_change moves no stock.
select set_config('request.jwt.claims', '{"email":"juniorsmcc@gmail.com"}', true);

update orders o
   set order_group = 'juniors'
  from stock_items s
 where s.id = o.stock_item_id
   and s.size ilike 'JNR%'
   and o.order_group is null
   and not (o.payment_status = 'paid' and o.distributed_at is not null);

select set_config('request.jwt.claims', '', true);
