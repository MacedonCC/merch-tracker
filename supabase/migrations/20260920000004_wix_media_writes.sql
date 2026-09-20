-- Let app/api/wix-media/route.ts write image_url and wix_product_url.
--
-- THE BLOCKER
--
-- check_stock_item_update() resolves the caller with
-- auth.jwt() ->> 'email' and raises 'Not authorised to update stock
-- items.' when no member matches. The wix-media route uses the
-- service-role client, which has no user identity at all, so every
-- write it attempted was rejected before any column check ran. This is
-- the same wall the historical cleanup and the size standardisation
-- migration hit.
--
-- THE FIX
--
-- A media-only update — one that changes nothing but image_url,
-- wix_product_url and updated_at — is allowed to proceed when there is
-- no signed-in member behind it. Those two columns are decoration: they
-- are not stock, price, targets or identity, and nothing derives from
-- them.
--
-- Why this is narrow rather than a blanket service-role exemption:
--
--   * It is scoped by COLUMN. Anything touching quantity, price,
--     targets, name, category, size or Wix linking falls straight
--     through to the existing checks, so a service-role caller gains no
--     ability to move stock or reprice anything.
--   * It is scoped by CALLER. A signed-in committee member still has
--     m.id set, so they skip this branch entirely and image_url /
--     wix_product_url stay admin-only for them, exactly as migration
--     20260920000002 set them up. No helper gains anything.
--   * Anonymous callers never get here: the "stock update" RLS policy
--     requires is_committee_member(), so an unauthenticated request is
--     refused before any trigger runs. The only caller that reaches
--     this branch is a service-role client, which bypasses RLS and is
--     only ever constructed server-side in a route that checks
--     CRON_SECRET first.
--
-- The comparison is done on the whole row via to_jsonb minus the three
-- allowed keys, rather than by listing columns to compare. A future
-- column added to stock_items is then covered automatically: if it
-- changes, the rows differ, media_only is false, and the normal checks
-- apply. Enumerating columns instead would silently let any new column
-- ride along inside a "media-only" update.

create or replace function check_stock_item_update()
returns trigger
language plpgsql
security definer
as $$
declare
  m members%rowtype;
  media_only boolean;
begin
  media_only := (
    to_jsonb(new) - 'image_url' - 'wix_product_url' - 'updated_at'
      = to_jsonb(old) - 'image_url' - 'wix_product_url' - 'updated_at'
  );

  select * into m from members where lower(members.email) = lower(auth.jwt() ->> 'email');

  if m.id is null then
    -- No signed-in member. Only the service-role wix-media route gets
    -- this far (see header), and only to refresh product artwork.
    if media_only then
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
