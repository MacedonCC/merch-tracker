-- The Wix order number (the "#10179" the shop and its emails show),
-- for display and search on the Orders page. Until now it lived only in
-- the free-text `notes` ("Wix order #10179"), which is not something to
-- search or match on. Display only: nothing about stock, payment,
-- handover or the payment-link matcher reads it.
--
-- wix-sync fills it on every new import. merge_payment_link_order()
-- gains a p_wix_order_number argument so a merged /sell order carries
-- it too, falling back to the deleted Wix row's own number. The old
-- four-argument function is dropped first: leaving both would make a
-- PostgREST call with named arguments ambiguous.
--
-- Existing rows are backfilled separately.

alter table orders add column if not exists wix_order_number text;

comment on column orders.wix_order_number is
  'Wix order number as shown in the shop (e.g. 10179). Display and search only.';

drop function if exists merge_payment_link_order(uuid, text, text, uuid);

create or replace function merge_payment_link_order(
  p_manual_id uuid,
  p_wix_order_id text,
  p_note text,
  p_wix_row_id uuid default null,
  p_wix_order_number text default null
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
         wix_order_number = coalesce(nullif(p_wix_order_number, ''), wix.wix_order_number),
         payment_status = 'paid',
         payment_method = 'online',
         notes = case when coalesce(notes, '') = '' then p_note else notes || E'\n' || p_note end
   where id = man.id;
  perform set_config('app.order_merge', '', true);
end;
$$;

revoke all on function merge_payment_link_order(uuid, text, text, uuid, text) from public, anon, authenticated;
grant execute on function merge_payment_link_order(uuid, text, text, uuid, text) to service_role;
