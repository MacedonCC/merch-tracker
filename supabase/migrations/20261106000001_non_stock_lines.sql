-- Non-stock lines: things sold through the Wix shop that the club wants
-- a record of but that never sit in the cupboard. The first (and today
-- only) one is the "Junior Playing Senior Cricket Fee", which wix-import
-- skips as a fee and wix-sync used to report as unmatched.
--
-- A non-stock line never moves stock and never counts as owed:
--   - the column is admin-only (check_stock_item_update), and a check
--     constraint pins its quantity at 0, so there is nothing to move;
--   - handle_distribution_change() and handle_order_removed() return
--     before touching stock_items or writing stock_movements;
--   - check_order_update() skips the unpaid-handover stock check;
--   - stock_overview reports committed / shortfall as 0 and status 'ok'
--     for it, so no total, tile or projection can pick it up even if a
--     screen forgets to filter it out.
-- The app additionally hides these lines from Stock, Restock, /sell,
-- Add order, the home tiles and the Wix push (which never writes the
-- fee's inventory, so Wix keeps it untracked and unlimited).
--
-- Function bodies below are the live definitions as of 6 Nov 2026 with
-- only the non-stock checks added.

alter table stock_items add column non_stock boolean not null default false;

alter table stock_items
  add constraint stock_items_non_stock_quantity_check
  check (not non_stock or quantity = 0);

comment on column stock_items.non_stock is
  'Record-keeping only (e.g. a fee sold through Wix). Never holds or moves stock, never counted as owed, hidden from Stock/Restock/sell and skipped by the Wix push.';

-- ---------------------------------------------------------------------
-- stock_overview: same columns, plus non_stock at the end (CREATE OR
-- REPLACE may only append). Grants survive a replace.
create or replace view stock_overview
with (security_invoker = on) as
  select
    s.id,
    s.name,
    s.category,
    s.size,
    s.price,
    s.quantity as on_hand,
    case when s.non_stock then 0::bigint else coalesce(c.committed, 0::bigint) end as committed,
    case when s.non_stock then 0::bigint else s.quantity - coalesce(c.committed, 0::bigint) end as available,
    case when s.non_stock then 0::bigint else greatest(coalesce(c.committed, 0::bigint) - s.quantity, 0::bigint) end as shortfall,
    s.low_stock_alert,
    s.low_stock_alert as minimum_level,
    s.target_level,
    s.wix_product_id,
    s.wix_variant_id,
    s.updated_at,
    case
      when s.non_stock then 'ok'::text
      when (s.quantity - coalesce(c.committed, 0::bigint)) < 0 then 'oversold'::text
      when s.quantity = 0 then 'out'::text
      when (s.quantity - coalesce(c.committed, 0::bigint)) <= s.low_stock_alert then 'low'::text
      else 'ok'::text
    end as stock_status,
    s.non_stock
  from stock_items s
  left join (
    select orders.stock_item_id, sum(orders.quantity) as committed
      from orders
     where orders.payment_status = 'paid'::text
       and orders.distributed_at is null
     group by orders.stock_item_id
  ) c on c.stock_item_id = s.id;

-- ---------------------------------------------------------------------
create or replace function is_non_stock(item uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select non_stock from stock_items where id = item), false);
$$;

-- ---------------------------------------------------------------------
create or replace function handle_distribution_change()
returns trigger
language plpgsql
security definer
as $$
declare
  target uuid;
begin
  if new.stock_item_id is null and new.given_stock_item_id is null then
    return new;
  end if;

  -- Non-stock lines (fees) never move stock or log a movement.
  if is_non_stock(coalesce(new.given_stock_item_id, new.stock_item_id))
     or is_non_stock(coalesce(old.given_stock_item_id, old.stock_item_id)) then
    return new;
  end if;

  if old.distributed_at is null and new.distributed_at is not null then
    target := coalesce(new.given_stock_item_id, new.stock_item_id);

    perform set_config('app.order_stock_change', '1', true);
    update stock_items
      set quantity = greatest(0, quantity - new.quantity),
          updated_at = now()
      where id = target;
    perform set_config('app.order_stock_change', '', true);

    insert into stock_movements (stock_item_id, change, reason, order_id)
      values (
        target, -new.quantity,
        case
          when new.given_stock_item_id is not null then
            'Handed over (substitute size given) — order ' || new.reference
          else
            'Handed over — order ' || new.reference
        end,
        new.id
      );
  end if;

  if old.distributed_at is not null and new.distributed_at is null then
    target := coalesce(old.given_stock_item_id, old.stock_item_id);

    perform set_config('app.order_stock_change', '1', true);
    update stock_items
      set quantity = quantity + new.quantity,
          updated_at = now()
      where id = target;
    perform set_config('app.order_stock_change', '', true);

    insert into stock_movements (stock_item_id, change, reason, order_id)
      values (target, new.quantity, 'Handover reversed — order ' || new.reference, new.id);
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
create or replace function handle_order_removed()
returns trigger
language plpgsql
security definer
as $$
declare
  target uuid;
begin
  target := coalesce(old.given_stock_item_id, old.stock_item_id);

  if target is not null and old.distributed_at is not null
     and not is_non_stock(target) then
    perform set_config('app.order_stock_change', '1', true);
    update stock_items
      set quantity = quantity + old.quantity,
          updated_at = now()
      where id = target;
    perform set_config('app.order_stock_change', '', true);

    insert into stock_movements (stock_item_id, change, reason)
      values (target, old.quantity, 'Order ' || old.reference || ' removed after handover');
  end if;
  return old;
end;
$$;

-- ---------------------------------------------------------------------
create or replace function check_order_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m members%rowtype;
  given_qty integer;
  target_id uuid;
  target_qty integer;
begin
  -- Set only inside merge_payment_link_order(), which never changes
  -- distributed_at, so none of the handover rules below apply to it.
  if coalesce(current_setting('app.order_merge', true), '') = '1' then
    return new;
  end if;

  select * into m from members where lower(members.email) = lower(auth.jwt() ->> 'email');

  if m.id is null then
    raise exception 'Not authorised to update orders.';
  end if;

  if new.given_stock_item_id is not null
     and old.distributed_at is null and new.distributed_at is not null then

    if m.role <> 'admin' then
      raise exception 'Only admins can hand over a different size.';
    end if;

    if not exists (
      select 1 from stock_items a
        join stock_items b on b.name = a.name
       where a.id = new.stock_item_id and b.id = new.given_stock_item_id
    ) then
      raise exception 'Given size must be the same product as the ordered item.';
    end if;

    select quantity into given_qty from stock_items where id = new.given_stock_item_id;
    if given_qty is null or given_qty < new.quantity then
      raise exception 'Not enough stock of the given size to hand over.';
    end if;
  end if;

  -- Unpaid handover may not take stock below on hand. A non-stock line
  -- (a fee) holds nothing, so there is nothing to check.
  if old.distributed_at is null and new.distributed_at is not null
     and new.payment_status is distinct from 'paid' then
    target_id := coalesce(new.given_stock_item_id, new.stock_item_id);
    if target_id is not null and not is_non_stock(target_id) then
      select quantity into target_qty from stock_items where id = target_id;
      if target_qty is null or target_qty < new.quantity then
        raise exception 'Not enough stock of this size to hand over an unpaid order.';
      end if;
    end if;
  end if;

  if m.role = 'admin' then
    return new;
  end if;

  if old.distributed_at is not null and new.distributed_at is null and not m.can_undo_handover then
    raise exception 'Missing permission: can_undo_handover';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Only change from the live version: non_stock joins the admin-only
-- identity fields. Service-role callers (wix-import, wix-media) already
-- cannot change it, because catalogue_only compares every other column.
create or replace function check_stock_item_update()
returns trigger
language plpgsql
security definer
as $$
declare
  m members%rowtype;
  catalogue_only boolean;
begin
  catalogue_only := (
    to_jsonb(new)
      - 'image_url' - 'wix_product_url' - 'wix_product_id' - 'wix_variant_id'
      - 'price' - 'wix_listed_at' - 'updated_at'
    = to_jsonb(old)
      - 'image_url' - 'wix_product_url' - 'wix_product_id' - 'wix_variant_id'
      - 'price' - 'wix_listed_at' - 'updated_at'
  );

  select * into m from members where lower(members.email) = lower(auth.jwt() ->> 'email');

  if m.id is null then
    if catalogue_only then
      if old.wix_listed_at is not null
         and new.wix_listed_at is distinct from old.wix_listed_at then
        raise exception 'wix_listed_at is set once when a line is first listed, and never changed.';
      end if;
      return new;
    end if;
    raise exception 'Not authorised to update stock items.';
  end if;

  if m.role = 'admin' then
    return new;
  end if;

  if coalesce(current_setting('app.order_stock_change', true), '') = '1' then
    return new;
  end if;

  if new.quantity is distinct from old.quantity and not m.can_adjust_stock then
    raise exception 'Missing permission: can_adjust_stock';
  end if;

  if new.price is distinct from old.price and not m.can_change_prices then
    raise exception 'Missing permission: can_change_prices';
  end if;

  if (new.target_level is distinct from old.target_level
      or new.low_stock_alert is distinct from old.low_stock_alert)
     and not m.can_change_targets then
    raise exception 'Missing permission: can_change_targets';
  end if;

  if new.name is distinct from old.name
     or new.category is distinct from old.category
     or new.size is distinct from old.size
     or new.wix_product_id is distinct from old.wix_product_id
     or new.wix_variant_id is distinct from old.wix_variant_id
     or new.image_url is distinct from old.image_url
     or new.wix_product_url is distinct from old.wix_product_url
     or new.wix_listed_at is distinct from old.wix_listed_at
     or new.retired_at is distinct from old.retired_at
     or new.non_stock is distinct from old.non_stock then
    raise exception 'Only admins can change item name, category, size, images, Wix linking or non-stock.';
  end if;

  return new;
end;
$$;

-- The fee line itself is inserted by 20261106000002, applied only after
-- the code that understands non_stock is deployed: with the line present
-- the previous wix-sync would have imported every fee order with no date
-- cut-off, and the previous push would have capped the fee at 0 in Wix.
