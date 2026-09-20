-- Record when a stock line was first listed in the Wix shop.
--
-- /restock projects demand from sales in the same season window last
-- year, and had to decide what "sold nothing" means. It used "not
-- linked to Wix" as a proxy for "could not have sold", which today's
-- catalogue import destroyed: 39 lines were linked or created today,
-- so they now read as having sold zero last season when in truth they
-- were not on sale at all. Worse, the proxy had already collapsed --
-- the only three unlinked lines all HAVE sales in the window, so the
-- "No history" label was unreachable and 66 lines reported a flat 0.
--
-- wix_listed_at answers the question directly. A line listed after the
-- season started could not have sold during it, whatever its link
-- status.
--
-- BACKFILL, in three groups:
--
--   A. 64 lines already linked before today's import -> 2023-01-01,
--      an explicit "listed before records begin" sentinel. We do not
--      know the true date; the oldest order in the system is
--      2023-09-12, so this is safely earlier than any season we can
--      project from. It is deliberately a round, obviously-artificial
--      date rather than a plausible-looking one.
--
--   B. 39 lines first listed today -> now(). That is the 18 lines the
--      import created plus the 21 existing lines it linked for the
--      first time, enumerated below. The 5 lines it merely refreshed a
--      variant id on are NOT in this group: they were in the shop last
--      season and only had their ids regenerated when their product's
--      size options were edited.
--
--   C. 3 lines with no Wix product -> null. All three happen to have
--      real sales in the window, and real sales always win over the
--      label, so this never actually surfaces.
--
-- 64 + 39 + 3 = 106. The 64 is self-checking: the pre-import baseline
-- recorded exactly 64 linked lines.

alter table stock_items
  add column if not exists wix_listed_at timestamptz;

alter table stock_items disable trigger check_stock_item_update;

-- Group A: everything currently linked, provisionally.
update stock_items
   set wix_listed_at = timestamptz '2023-01-01 00:00 Australia/Melbourne'
 where wix_product_id is not null;

-- Group B, part one: the 21 lines the import linked for the first time.
with newly_linked(name, size) as (values
  ('Broad Rim Playing Hat','L'),
  ('Broad Rim Playing Hat','XL'),
  ('Men''s One Day Coloured Playing Pants','2XL'),
  ('Men''s One Day Coloured Playing Pants','3XL'),
  ('Men''s One Day Coloured Playing Pants','JNR10'),
  ('Men''s One Day Coloured Playing Pants','JNR12'),
  ('Men''s One Day Coloured Playing Pants','XL'),
  ('Men''s One Day Playing Shirt','JNR10'),
  ('Men''s One Day Playing Shirt','JNR12'),
  ('Men''s One Day Playing Shirt','JNR14'),
  ('Men''s One Day Playing Shirt','JNR8'),
  ('Women''s One Day Coloured Playing Pants','2XL'),
  ('Women''s One Day Coloured Playing Pants','3XL'),
  ('Women''s One Day Coloured Playing Pants','JNR10'),
  ('Women''s One Day Coloured Playing Pants','JNR8'),
  ('Women''s One Day Coloured Playing Pants','XL'),
  ('Women''s One Day Playing Shirt','2XL'),
  ('Women''s One Day Playing Shirt','L'),
  ('Women''s One Day Playing Shirt','M'),
  ('Women''s One Day Playing Shirt','S'),
  ('Women''s One Day Playing Shirt','XL')
)
update stock_items s
   set wix_listed_at = now()
  from newly_linked n
 where s.name = n.name and s.size = n.size;

-- Group B, part two: the 18 lines it created today.
update stock_items
   set wix_listed_at = now()
 where wix_product_id is not null
   and created_at >= (timestamptz '2026-09-20 00:00 Australia/Melbourne');

alter table stock_items enable trigger check_stock_item_update;

-- wix_listed_at joins the catalogue columns a service-role sync may
-- write, so app/api/wix-import can stamp it. It is WRITE-ONCE for such
-- a caller: the route sets it only when first linking or creating a
-- line, and this makes that structural rather than a convention the
-- next edit to the route could quietly drop.
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
     or new.wix_listed_at is distinct from old.wix_listed_at then
    raise exception 'Only admins can change item name, category, size, images or Wix linking.';
  end if;

  return new;
end;
$BODY$;
