-- Merge a /sell payment-link order with the Wix order that paid for it.
--
-- A payment link only opens the Wix product page, so the customer's
-- payment arrives as a separate Wix order, which wix-sync imports as a
-- second row while the /sell row stays unpaid. Which pairs belong
-- together is decided in lib/payment-link-match.ts; this function only
-- applies a decision, in one transaction.
--
-- THE MANUAL ROW SURVIVES. It keeps the coach's name, the customer's
-- email, its reference and its handover state, and takes the Wix
-- order id, `paid` and `online`, plus a note naming the payer. Holding
-- the Wix order id with the SAME stock_item_id is what stops a later
-- wix-sync re-importing the line: its dedup key and the
-- orders_wix_order_line_key constraint are (wix_order_id,
-- stock_item_id), so the same item is required, not just checked.
--
-- Two callers:
--   - the reconciliation, for a Wix line already imported as its own
--     row (p_wix_row_id set): that row is deleted first, because it
--     holds the (wix_order_id, stock_item_id) pair the manual row is
--     about to take.
--   - wix-sync, for a line not yet inserted (p_wix_row_id null): only
--     the update runs.
--
-- STOCK DOES NOT MOVE. Stock moves only when distributed_at changes,
-- or when a handed-over order is deleted. The update leaves
-- distributed_at alone, and a Wix row that has been handed over is
-- refused rather than deleted: wix-sync inserts a Wix-FULFILLED order
-- with distributed_at already set and no stock movement, so
-- handle_order_removed() would put back stock that never came out.
-- A manual order handed over at the ground has already had its one
-- deduction; after the merge it is paid and still handed over, so
-- stock_overview stops counting the paid Wix line as committed.
--
-- check_order_update() resolves the caller from the JWT and refuses an
-- update with none, which is always the case for the service-role
-- sync. This function sets a transaction-local app.order_merge flag
-- around its one update and check_order_update() returns early on it,
-- the same pattern as app.order_stock_change. The flag cannot be set
-- through PostgREST, and the function itself is service-role only.

create or replace function merge_payment_link_order(
  p_manual_id uuid,
  p_wix_order_id text,
  p_note text,
  p_wix_row_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  man orders%rowtype;
  wix orders%rowtype;
begin
  select * into man from orders where id = p_manual_id for update;
  if man.id is null then
    raise exception 'Manual order not found.';
  end if;
  if man.source <> 'manual' or man.payment_status <> 'pending' or man.wix_order_id is not null then
    raise exception 'Order % is not an open manual order.', man.reference;
  end if;
  if p_wix_order_id is null or p_wix_order_id = '' then
    raise exception 'A Wix order id is required.';
  end if;

  if p_wix_row_id is not null then
    select * into wix from orders where id = p_wix_row_id for update;
    if wix.id is null then
      raise exception 'Wix order row not found.';
    end if;
    if wix.source <> 'wix' or wix.payment_status <> 'paid' or wix.wix_order_id is distinct from p_wix_order_id then
      raise exception 'Order % is not the paid Wix order %.', wix.reference, p_wix_order_id;
    end if;
    if wix.stock_item_id is distinct from man.stock_item_id then
      raise exception 'Orders % and % are for different items.', man.reference, wix.reference;
    end if;
    if wix.quantity <> man.quantity then
      raise exception 'Orders % and % have different quantities.', man.reference, wix.reference;
    end if;
    if wix.distributed_at is not null then
      raise exception 'Wix order % is already handed over; merge it by hand.', wix.reference;
    end if;

    -- Not handed over, so handle_order_removed() moves no stock.
    delete from orders where id = wix.id;
  end if;

  perform set_config('app.order_merge', '1', true);
  update orders
     set wix_order_id = p_wix_order_id,
         payment_status = 'paid',
         payment_method = 'online',
         notes = case when coalesce(notes, '') = '' then p_note else notes || E'\n' || p_note end
   where id = man.id;
  perform set_config('app.order_merge', '', true);
end;
$$;

revoke all on function merge_payment_link_order(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function merge_payment_link_order(uuid, text, text, uuid) to service_role;

-- Unchanged from 20261008000002 apart from the app.order_merge early
-- return at the top.
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
