-- Let a committee member hand over an order without holding
-- can_adjust_stock.
--
-- THE BUG (pre-existing, not introduced by /sell)
--
-- Handing over an order sets distributed_at, which fires
-- on_distribution_change -> handle_distribution_change, whose job is to
-- take the garment out of the cupboard:
--
--     update stock_items set quantity = greatest(0, quantity - ...)
--
-- That inner UPDATE fires check_stock_item_update, which sees the
-- quantity change and demands can_adjust_stock. handle_distribution_change
-- is SECURITY DEFINER, but that only changes the ROLE — triggers still
-- fire, and auth.jwt() still resolves to the signed-in member. So every
-- helper without can_adjust_stock got:
--
--     Missing permission: can_adjust_stock
--
-- All four committee members currently have can_adjust_stock = false,
-- so only an admin could complete a handover. That already broke the
-- "Hand over" button in TrackerSection; it would also have broken every
-- cash sale in the new /sell flow, which is a handover by another name.
--
-- THE FIX
--
-- can_adjust_stock is meant to gate MANUALLY editing a stock count, not
-- the automatic consequence of giving out an order the member is already
-- allowed to give out. The two order triggers therefore raise a
-- transaction-local flag around their stock writes, and
-- check_stock_item_update treats a flagged change as already authorised
-- by the order permission that let the handover happen in the first
-- place.
--
-- The flag is set with is_local => true, so it lives only for the
-- current transaction and cannot leak into another statement. It is not
-- settable through PostgREST, so a client cannot raise it by hand; the
-- only way in is through these two triggers.
--
-- What is deliberately NOT relaxed: undoing a handover still requires
-- can_undo_handover (enforced separately in check_order_update), and
-- editing a quantity directly on the Stock page still requires
-- can_adjust_stock, because neither goes through these triggers.

create or replace function handle_distribution_change()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.stock_item_id is null then
    return new;
  end if;

  -- Handed over: take it out of the cupboard.
  if old.distributed_at is null and new.distributed_at is not null then
    perform set_config('app.order_stock_change', '1', true);
    update stock_items
      set quantity = greatest(0, quantity - new.quantity),
          updated_at = now()
      where id = new.stock_item_id;
    perform set_config('app.order_stock_change', '', true);

    insert into stock_movements (stock_item_id, change, reason, order_id)
      values (new.stock_item_id, -new.quantity,
              'Handed over — order ' || new.reference, new.id);
  end if;

  -- Handover undone: put it back.
  if old.distributed_at is not null and new.distributed_at is null then
    perform set_config('app.order_stock_change', '1', true);
    update stock_items
      set quantity = quantity + new.quantity,
          updated_at = now()
      where id = new.stock_item_id;
    perform set_config('app.order_stock_change', '', true);

    insert into stock_movements (stock_item_id, change, reason, order_id)
      values (new.stock_item_id, new.quantity,
              'Handover reversed — order ' || new.reference, new.id);
  end if;

  return new;
end;
$$;

-- Same treatment for the delete path. Deleting an order is admin-only at
-- the RLS layer, so this is not currently reachable by a helper, but
-- leaving it inconsistent would be a trap for whoever changes that
-- policy next.
create or replace function handle_order_removed()
returns trigger
language plpgsql
security definer
as $$
begin
  if old.stock_item_id is not null and old.distributed_at is not null then
    perform set_config('app.order_stock_change', '1', true);
    update stock_items
      set quantity = quantity + old.quantity,
          updated_at = now()
      where id = old.stock_item_id;
    perform set_config('app.order_stock_change', '', true);

    insert into stock_movements (stock_item_id, change, reason)
      values (old.stock_item_id, old.quantity,
              'Order ' || old.reference || ' removed after handover');
  end if;
  return old;
end;
$$;

create or replace function check_stock_item_update()
returns trigger
language plpgsql
security definer
as $$
declare
  m members%rowtype;
begin
  select * into m from members where lower(members.email) = lower(auth.jwt() ->> 'email');

  if m.id is null then
    raise exception 'Not authorised to update stock items.';
  end if;

  if m.role = 'admin' then
    return new;
  end if;

  -- Stock moved as a consequence of an order handover, not a manual
  -- edit. The member was already entitled to hand the order over, so
  -- the column-level checks below do not apply. See the header comment.
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
     or new.wix_product_url is distinct from old.wix_product_url then
    raise exception 'Only admins can change item name, category, size, images or Wix linking.';
  end if;

  return new;
end;
$$;
