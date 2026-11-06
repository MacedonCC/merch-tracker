-- "Mark handed over (no stock change)": for an order whose garment left
-- the cupboard before the stock count it came out of was taken, so
-- deducting it now would take it off twice. Admin only, note required,
-- logged as a change-0 stock_movements row (the same shape as the
-- September HIST cleanup).
--
-- orders.handover_no_stock records that a handover moved nothing, so
-- that UNDOING it or DELETING the order does not put back stock that
-- never came out. It cannot be set directly by anyone: the BEFORE
-- UPDATE trigger derives it on every update -
--   handed over in this update -> true only inside
--     mark_handed_over_no_stock() (transaction-local flag, which
--     PostgREST cannot set);
--   not handed over -> false;
--   stays handed over -> unchanged.
-- so a helper writing handover_no_stock = true alongside an ordinary
-- handover still has stock deducted.
--
-- Function bodies are the live definitions from 20261106000001 with
-- only the handover_no_stock checks added.

alter table orders add column handover_no_stock boolean not null default false;

comment on column orders.handover_no_stock is
  'Handed over without a stock deduction (mark_handed_over_no_stock). Undo/delete then restores nothing. Derived by check_order_update(); not writable.';

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
  no_stock boolean := coalesce(current_setting('app.no_stock_handover', true), '') = '1';
begin
  if new.distributed_at is null then
    new.handover_no_stock := false;
  elsif old.distributed_at is null then
    new.handover_no_stock := no_stock;
  else
    new.handover_no_stock := old.handover_no_stock;
  end if;

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

  -- Unpaid handover may not take stock below on hand. Nothing is taken
  -- by a non-stock line (a fee) or a no-stock-change handover.
  if old.distributed_at is null and new.distributed_at is not null
     and new.payment_status is distinct from 'paid'
     and not new.handover_no_stock then
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

  -- A no-stock-change handover takes nothing out (its change-0 row is
  -- written by mark_handed_over_no_stock()).
  if old.distributed_at is null and new.distributed_at is not null
     and not new.handover_no_stock then
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

  -- Undoing it puts back nothing, since nothing came out.
  if old.distributed_at is not null and new.distributed_at is null
     and not old.handover_no_stock then
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
     and not old.handover_no_stock
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
create or replace function mark_handed_over_no_stock(
  p_order_id uuid,
  p_note text,
  p_handed_over_by text,
  p_handed_over_at timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m members%rowtype;
  o orders%rowtype;
begin
  select * into m from members where lower(members.email) = lower(auth.jwt() ->> 'email');
  if m.id is null or m.role <> 'admin' then
    raise exception 'Only admins can mark an order handed over without a stock change.';
  end if;

  if coalesce(btrim(p_note), '') = '' then
    raise exception 'A note is required.';
  end if;
  if coalesce(btrim(p_handed_over_by), '') = '' then
    raise exception 'Initials are required.';
  end if;

  select * into o from orders where id = p_order_id for update;
  if o.id is null then
    raise exception 'Order not found.';
  end if;
  if o.distributed_at is not null then
    raise exception 'Order % is already handed over.', o.reference;
  end if;

  perform set_config('app.no_stock_handover', '1', true);
  update orders
     set distributed_at = coalesce(p_handed_over_at, now()),
         handed_over_by = btrim(p_handed_over_by),
         handover_note = btrim(p_note)
   where id = p_order_id;
  perform set_config('app.no_stock_handover', '', true);

  insert into stock_movements (stock_item_id, change, reason, order_id, created_by)
    values (
      o.stock_item_id, 0,
      'Marked handed over, no stock change — order ' || o.reference || ': ' || btrim(p_note),
      o.id, m.email
    );
end;
$$;

revoke all on function mark_handed_over_no_stock(uuid, text, text, timestamptz) from public, anon;
grant execute on function mark_handed_over_no_stock(uuid, text, text, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- One-off: Cameron Howlett (Wix #10147, White Playing Shirt L x3) and
-- Ivan Bobetic (Wix #10152, White Playing Shirt - Long Sleeve M x1)
-- were physically handed over before stock was balanced. Recorded the
-- HIST way: handed over, no stock change, a change-0 movement. The rows
-- keep their (wix_order_id, stock_item_id), so wix-sync's dedup holds.
-- distributed_at uses the order date; the real date is not known.
do $$
declare
  r record;
  n integer := 0;
begin
  perform set_config('request.jwt.claims', '{"email":"juniorsmcc@gmail.com"}', true);

  for r in
    select o.id, o.reference, o.stock_item_id, o.ordered_at
      from orders o
     where (o.wix_order_id, o.stock_item_id) in (
             ('7adc4c64-f02b-4142-91df-5dfb9314b0ba', '77adc02b-1322-4d45-a6e6-5f44b3e76706'::uuid),
             ('86910e83-28ff-4065-9ce5-c8fec9b61c0a', '2e91db92-df95-40c1-805a-f22a1571a690'::uuid))
       and o.distributed_at is null
  loop
    perform set_config('app.no_stock_handover', '1', true);
    update orders
       set distributed_at = r.ordered_at,
           handed_over_by = 'HIST',
           handover_note = 'Handed over before stock balanced'
     where id = r.id;
    perform set_config('app.no_stock_handover', '', true);

    insert into stock_movements (stock_item_id, change, reason, order_id, created_by)
      values (r.stock_item_id, 0,
              'Handed over before stock balanced — no stock change — order ' || r.reference,
              r.id, 'HIST');
    n := n + 1;
  end loop;

  if n <> 2 then
    raise exception 'Expected 2 open lines (Howlett #10147, Bobetic #10152), found %. Nothing changed.', n;
  end if;

  perform set_config('request.jwt.claims', '', true);
end $$;
