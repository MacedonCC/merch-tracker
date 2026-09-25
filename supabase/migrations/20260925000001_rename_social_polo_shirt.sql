-- Rename "Social Polo Shirt" to "Men's Social Polo Shirt".
--
-- Migration 20260920000008 aligned seven product names with Wix and
-- deliberately left this one alone, for the reason recorded there:
-- "Social Polo Shirt — no Wix product". That has changed. The club has
-- renamed the product in Wix to "Men's Social Polo Shirt", turned on
-- per-variant pricing and inventory, and listed a companion
-- "Women's Social Polo Shirt". The tracker's name has to follow.
--
-- WHY THIS MUST HAPPEN BEFORE THE NEXT wix-import RUN. findRow() in
-- app/api/wix-import/route.ts matches by variant id, then product id,
-- then name+size, and for this product all three currently miss:
--
--   variant id  — these rows hold none. Per-variant management was off
--                 in Wix until now, so there were no variant ids to
--                 store. (Confirmed by the 25 Sep dry run: every entry
--                 in staleVariantIds was empty, and a row holding a
--                 variant id for a product absent from the catalogue
--                 response would have appeared there.)
--   product id  — byProduct only holds a Wix product when exactly ONE
--                 tracker row carries its id. Eleven sizes share this
--                 one, so the fallback is skipped by design.
--   name + size — nameSizeKey squashes punctuation and case, not an
--                 added word: "socialpoloshirt" never equals
--                 "menssocialpoloshirt".
--
-- With all three missing, the import would file all eleven sizes as
-- toCreate and build a parallel set of empty lines under the new name,
-- leaving the real stock and the JNR14/JNR16 sales history stranded on
-- rows no Wix order could ever reach again. Nothing raises when that
-- happens: stock_items_name_size_key is on (name, size), and the name
-- differs, so the duplicates insert cleanly and silently. This is the
-- same failure 20260920000008 was written to prevent, arriving for the
-- one product that migration could not yet fix.
--
-- After the rename the name+size fallback matches all eleven, so the
-- import reports them as toLink rather than toCreate and does nothing
-- but attach the new variant ids and the $50 price.
--
-- NOTHING BUT `name` CHANGES. quantity is not in the update, so no
-- on-hand count moves and no trigger on orders fires. Orders reference
-- stock_items by id, so every past order, handover and stock_movements
-- row follows the rename automatically — none is repointed, and the
-- JNR14/JNR16 history /restock reads stays attached to the same rows.
-- wix_listed_at is untouched, so those lines keep their "was on sale"
-- standing and do not read as new to the shop. retired_at, price and
-- the Wix link columns are all left for the import to reconcile.
--
-- THE COLLISION GUARD IS CHECKED HERE RATHER THAN ASSERTED. The two
-- earlier renames both say a human verified no target (name, size)
-- already existed. This one proves it inside the transaction: if any
-- "Men's Social Polo Shirt" row exists at that size already, the
-- migration aborts before writing anything rather than failing halfway
-- on the unique constraint.
--
-- TRIGGER WORKAROUND: check_stock_item_update treats `name` as an
-- identity column, outside the service-role catalogue exemption that
-- migration 20260920000007 opened, and raises without a JWT in any
-- case. Disabled for the single statement, as migrations
-- 20260920000005, 20260920000006 and 20260920000008 did. The ALTER
-- holds an ACCESS EXCLUSIVE lock until commit, so no concurrent write
-- escapes the check.

do $$
declare
  clash text;
begin
  select string_agg(size, ', ' order by size)
    into clash
    from stock_items
   where name = 'Men''s Social Polo Shirt'
     and size in (select size from stock_items where name = 'Social Polo Shirt');

  if clash is not null then
    raise exception
      'Rename aborted: "Men''''s Social Polo Shirt" already exists at size(s) %. '
      'These rows would need merging, not renaming.', clash;
  end if;
end $$;

-- The audit trail first, while the rows still say what they were
-- called. Zero-change rows, matching the precedent migration
-- 20260920000001 set for a rename that moves no stock: a name change
-- with no trail reads later as a line that silently became a different
-- product.
insert into stock_movements (stock_item_id, change, reason, created_by)
select id,
       0,
       'Renamed "Social Polo Shirt" to "Men''s Social Polo Shirt" to match Wix '
         || '— name only, no stock moved',
       'MIGRATION'
  from stock_items
 where name = 'Social Polo Shirt';

alter table stock_items disable trigger check_stock_item_update;

update stock_items
   set name = 'Men''s Social Polo Shirt',
       updated_at = now()
 where name = 'Social Polo Shirt';

alter table stock_items enable trigger check_stock_item_update;
