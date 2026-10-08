-- Hand over an unpaid order. The stock side already works: stock moves
-- on the distributed_at transition whatever payment_status is, and Mark
-- paid never touches distributed_at, so it leaves stock alone. The one
-- gap was that a handover could take stock below what was on hand
-- (clamped to zero, silently). check_order_update() now refuses that
-- for an unpaid order. Everything else in the function is unchanged
-- from 20261004000001.

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
  select * into m from members where lower(members.email) = lower(auth.jwt() ->> 'email');

  if m.id is null then
    raise exception 'Not authorised to update orders.';
  end if;

  -- Only checked at the moment of a fresh handover that carries a
  -- substitution, so correcting a handover note later never re-runs
  -- these against stock levels that have since moved for other reasons.
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

  -- An unpaid order can be handed over (customer takes it now, pays
  -- later). handle_distribution_change() clamps at zero rather than
  -- refusing, which would silently hide a handover of stock that is not
  -- there, so refuse it here instead. Paid orders keep the old rules.
  if old.distributed_at is null and new.distributed_at is not null
     and new.payment_status is distinct from 'paid' then
    target_id := coalesce(new.given_stock_item_id, new.stock_item_id);
    if target_id is not null then
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
