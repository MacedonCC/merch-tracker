-- Admin-only "hand over a different size" — the customer ordered one
-- size and was given another (wrong size in stock, garment damaged,
-- whatever the reason), and until now there was no way to record that
-- without either lying about what was handed over or deleting the
-- order and risking the daily wix-sync re-importing it.
--
-- `orders.stock_item_id` MUST NOT MOVE. It is the Wix-matched identity
-- of the order line: wix-sync's dedup key and unique constraint are
-- `(wix_order_id, stock_item_id)` (migration 20260905000006), and
-- `stock_overview.committed` groups pending orders by it. Repointing
-- it at the given size would make a re-run of wix-sync think the
-- original line was never imported and insert a duplicate. So the
-- ordered size stays exactly where it already lived, and a new
-- nullable `given_stock_item_id` records the substitution only when
-- one happened. Null means "handed over normally," which is what
-- every existing order already is.
--
-- Three trigger functions change, nothing else does:
--
-- handle_distribution_change() / handle_order_removed() now move
-- stock against `coalesce(given_stock_item_id, stock_item_id)` instead
-- of `stock_item_id` alone, on both the deduct-on-handover and
-- restore-on-undo/restore-on-delete paths. The quantity moved is
-- still `quantity` off the order row — a substitution changes which
-- size pays for the order, not how many units it is.
--
-- check_order_update() gains the gate: setting `given_stock_item_id`
-- (a) is admin-only — this is a correction flow, not an ordinary
-- handover any committee member can do, (b) must name a stock_items
-- row with the SAME product name as the ordered item (enforced here
-- because writes come straight from the browser client, not an API
-- route — the UI filtering the size picker to the same product is not
-- a substitute for the database also refusing an unrelated product),
-- and (c) is refused if the given size does not have enough on hand to
-- cover the order's quantity — requirement from the committee: a
-- substitution must never oversell the size being substituted onto.
-- All three checks are scoped to the moment stock would actually move
-- (old.distributed_at is null and new.distributed_at is not null), so
-- they fire once at handover time and never re-fire on an unrelated
-- later edit (e.g. correcting the handover note).

alter table orders
  add column if not exists given_stock_item_id uuid references stock_items(id);

comment on column orders.given_stock_item_id is
  'Set only when the size actually handed over differs from stock_item_id (the size ordered). Null for every ordinary handover.';

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

  -- Handed over: take it out of the cupboard. A substitution takes it
  -- off the size actually given, not the size ordered.
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

  -- Handover undone: put it back on whichever size it actually came
  -- off — OLD still holds given_stock_item_id even if this same update
  -- is clearing it.
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

create or replace function handle_order_removed()
returns trigger
language plpgsql
security definer
as $$
declare
  target uuid;
begin
  target := coalesce(old.given_stock_item_id, old.stock_item_id);

  if target is not null and old.distributed_at is not null then
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

create or replace function check_order_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m members%rowtype;
  given_qty integer;
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

  if m.role = 'admin' then
    return new;
  end if;

  if old.distributed_at is not null and new.distributed_at is null and not m.can_undo_handover then
    raise exception 'Missing permission: can_undo_handover';
  end if;

  return new;
end;
$$;
