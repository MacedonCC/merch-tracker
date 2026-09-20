-- Supporting columns for the /sell quick-sale flow.
--
-- orders.payment_method records how a sale was paid for:
--   cash    — handed over at the ground, money taken in person
--   online  — paid through the Wix shop
--   unknown — not recorded (every row that predates this column)
--
-- Historical manual orders genuinely are unknown, so the default covers
-- them. Wix-sourced rows are backfilled to 'online' because that is what
-- they actually were; leaving them 'unknown' would discard information
-- the source column already proves.
alter table orders
  add column if not exists payment_method text not null default 'unknown';

alter table orders
  drop constraint if exists orders_payment_method_check;

alter table orders
  add constraint orders_payment_method_check
  check (payment_method in ('cash', 'online', 'unknown'));

-- check_order_update (BEFORE UPDATE on orders) resolves the caller via
-- auth.jwt() ->> 'email' and raises 'Not authorised to update orders.'
-- when there is no JWT, which is always true inside a migration. The
-- first attempt at this migration failed on exactly that. Disabled for
-- the backfill only; the ALTER holds an ACCESS EXCLUSIVE lock until
-- commit, so no concurrent write escapes the check.
--
-- on_distribution_change is deliberately left ENABLED: it only acts on a
-- distributed_at transition, and this statement touches payment_method
-- alone, so no stock moves.
alter table orders disable trigger check_order_update;

update orders
   set payment_method = 'online'
 where source = 'wix'
   and payment_method = 'unknown';

alter table orders enable trigger check_order_update;

-- stock_items gains the two fields the sell flow needs from Wix.
-- Both are nullable: an item that was never linked to Wix has neither,
-- and the UI falls back to a text tile / hides the payment link.
--   image_url       — primary product image, for the product grid
--   wix_product_url — the item's own shop page, texted to a parent so
--                     they land on the exact product rather than the
--                     shop front. These are NOT PlayHQ links; PlayHQ is
--                     registration, not merchandise.
-- Populated by app/api/wix-media/route.ts, keyed on wix_product_id.
alter table stock_items
  add column if not exists image_url text;

alter table stock_items
  add column if not exists wix_product_url text;

-- check_stock_item_update blocks non-admins from changing item identity
-- fields and raises outright when there is no JWT. It compares OLD/NEW
-- per column and knows nothing about these two, so the wix-media route
-- (service-role, no JWT) would trip it. Both columns are written only by
-- that route, never by the UI, so they are added to the identity guard
-- as admin-only rather than left silently ungoverned.
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
