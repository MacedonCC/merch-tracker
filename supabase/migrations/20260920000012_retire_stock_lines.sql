-- Mark a stock line as no longer sold, so /restock stops ordering it.
--
-- "One Day Coloured Playing Pants (pre-2026)" is the combined pants
-- line that migration 20260920000006 retired: renamed, Wix link
-- cleared, kept only so its 7 historical orders stay attached to a
-- product. But /restock still saw 2 units of demand in last season's
-- window and duly suggested buying 2 more of a product the club no
-- longer sells.
--
-- There was no way to express "this existed, it sold, and it is
-- finished" - only whether a line is linked to Wix, which is a
-- different question. An unlinked line may simply never have been in
-- the online shop while still being sold at the ground. Hence an
-- explicit column rather than inferring retirement from absence.
--
-- Deliberately only this one line. Social Polo Shirt JNR14/JNR16 are
-- also unlinked and also suggesting orders, but they sold as recently
-- as January 2026 and nothing says they are discontinued - only that
-- they are not in the Wix catalogue and carry no price. Retiring them
-- is a decision for the committee, not an inference from missing data.
--
-- Not added to the catalogue-sync exemption: retiring is a deliberate
-- human act, so it stays admin-only like name and category, and a
-- service-role import can never set or clear it.

alter table stock_items
  add column if not exists retired_at timestamptz;

comment on column stock_items.retired_at is
  'When the club stopped selling this line. Non-null means /restock ignores it entirely. Stock, orders and history are untouched.';

alter table stock_items disable trigger check_stock_item_update;

update stock_items
   set retired_at = now(), updated_at = now()
 where name = 'One Day Coloured Playing Pants (pre-2026)'
   and retired_at is null;

alter table stock_items enable trigger check_stock_item_update;

create or replace function check_stock_item_update()
returns trigger
language plpgsql
security definer
as $BODY$
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
     or new.retired_at is distinct from old.retired_at then
    raise exception 'Only admins can change item name, category, size, images or Wix linking.';
  end if;

  return new;
end;
$BODY$;
