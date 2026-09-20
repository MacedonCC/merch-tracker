-- Let the Wix catalogue sync reconcile catalogue metadata on existing
-- stock lines, without ever touching stock.
--
-- Migration 20260920000004 opened a narrow door for app/api/wix-media:
-- a service-role caller (no signed-in member) may change image_url and
-- wix_product_url and nothing else. app/api/wix-import needs the same
-- shape of door to link a tracker line to its Wix product and variant
-- and to bring the price across, so the two are unified into one
-- "catalogue columns" rule rather than growing a second, overlapping
-- exemption:
--
--     image_url, wix_product_url, wix_product_id, wix_variant_id, price
--
-- What stays blocked is the point of the rule. quantity, name,
-- category, size, low_stock_alert and target_level are all outside the
-- set, so a catalogue sync can never move stock, rename an item,
-- re-size it or change its reorder thresholds. wix-import used to send
-- quantity: 0 in its upsert payload, which would have zeroed every
-- matched line; under this rule such an update is refused outright
-- rather than relied upon to be well behaved.
--
-- The caller restriction is unchanged and is what keeps this narrow:
-- a signed-in member still has m.id set and skips the branch entirely,
-- so these columns remain admin-only through the UI. Anonymous callers
-- never reach the trigger, since the "stock update" RLS policy requires
-- is_committee_member(). The only callers that land here are
-- service-role clients, constructed server-side in routes that check
-- CRON_SECRET first.
--
-- The comparison subtracts the allowed keys from the whole row rather
-- than listing columns to compare, so a column added to stock_items
-- later is covered automatically instead of silently riding along.

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
      - 'price' - 'updated_at'
    = to_jsonb(old)
      - 'image_url' - 'wix_product_url' - 'wix_product_id' - 'wix_variant_id'
      - 'price' - 'updated_at'
  );

  select * into m from members where lower(members.email) = lower(auth.jwt() ->> 'email');

  if m.id is null then
    -- No signed-in member: a service-role catalogue sync (wix-import,
    -- wix-media). Allowed to reconcile catalogue metadata only.
    if catalogue_only then
      return new;
    end if;
    raise exception 'Not authorised to update stock items.';
  end if;

  if m.role = 'admin' then
    return new;
  end if;

  -- Stock moved as a consequence of an order handover, not a manual
  -- edit (migration 20260920000003).
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
