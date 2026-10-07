-- Rename "Men's White Playing Shirt" to "White Playing Shirt", and
-- "Men's White Playing Shirt - Long Sleeve" to "White Playing Shirt -
-- Long Sleeve", to follow the same rename being made in Wix straight
-- after this is applied (no change to sizes, prices or options).
--
-- WHY THIS MUST BE APPLIED BEFORE THE WIX RENAME. findRow() in
-- app/api/wix-import/route.ts matches by variant id first, so these
-- lines (every size carries a wix_variant_id) keep matching through the
-- rename and the import should report toCreate 0, staleVariantIds
-- empty, and nameDrift empty once both sides agree. Renaming Wix first
-- would leave a window where tracker and Wix names differ (nameDrift).
--
-- NOTHING BUT `name` (and updated_at) CHANGES. quantity is not in the
-- update, so no on-hand count moves and no trigger on orders fires.
-- Orders reference stock_items by id, so order history and existing
-- stock_movements rows follow the rename without being repointed.
-- wix_listed_at, retired_at, price and the Wix link columns are untouched.
--
-- COLLISION GUARD: if any row already carries either new name, at any
-- size, abort before writing anything rather than fail halfway on
-- stock_items_name_size_key (or worse, merge silently).
--
-- TRIGGER WORKAROUND: check_stock_item_update treats `name` as an
-- identity column and raises without a JWT, so it is disabled for the
-- single UPDATE, as in migrations 20260920000008 and 20260925000001.
-- The ALTER holds an ACCESS EXCLUSIVE lock until commit.

do $$
declare
  clash text;
begin
  select string_agg(distinct name || ' / ' || size, ', ')
    into clash
    from stock_items
   where name in ('White Playing Shirt', 'White Playing Shirt - Long Sleeve');

  if clash is not null then
    raise exception
      'Rename aborted: target name(s) already exist: %. '
      'These rows would need merging, not renaming.', clash;
  end if;
end $$;

insert into stock_movements (stock_item_id, change, reason, created_by)
select id,
       0,
       'Renamed "' || name || '" to "' || substr(name, 7)
         || '" to match Wix — name only, no stock moved',
       'MIGRATION'
  from stock_items
 where name in ('Men''s White Playing Shirt',
                'Men''s White Playing Shirt - Long Sleeve');

alter table stock_items disable trigger check_stock_item_update;

update stock_items
   set name = substr(name, 7),
       updated_at = now()
 where name in ('Men''s White Playing Shirt',
                'Men''s White Playing Shirt - Long Sleeve');

alter table stock_items enable trigger check_stock_item_update;
