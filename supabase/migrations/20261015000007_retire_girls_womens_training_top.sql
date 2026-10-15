-- Retire "Girl's and Women's Training Top / One size".
--
-- The Wix product behind it has been renamed "Women's Training Top" and
-- given twelve sizes (JNR8-JNR16, L6-L18). Wix kept the product id, so
-- this unsized row - the only one carrying that id - is what wix-import's
-- product-id fallback reached for: a dry run linked it to L14 and
-- reported the other eleven sizes as conflicts. The twelve sizes are new
-- lines; this one is finished.
--
-- SAFE: on hand 0, committed 0, no open orders. Its 7 past orders (8
-- units, all paid and handed over) stay attached by stock_item_id.
--
-- wix_product_id IS KEPT, deliberately. wix-sync recognises an
-- already-imported Wix line by (wix_order_id, stock_item_id), and finds
-- the stock_item_id for this line's past orders through that id. Keeping
-- the link cannot misbind anything in the import any more, because
-- wix-import now ignores retired rows for all matching (variant id,
-- product id and name). wix_variant_id is already null.
--
-- A zero-change movement row records the retirement, as migration
-- 20260922000001 did for its JNR16, so the line does not simply stop
-- being mentioned.
--
-- TRIGGER WORKAROUND: check_stock_item_update resolves the caller with
-- auth.jwt() and raises with no JWT, and retired_at is admin-only.
-- Disabled for the one statement, as migrations 20260920000012 and
-- 20260922000001 did. The ALTER holds an ACCESS EXCLUSIVE lock until
-- commit.

insert into stock_movements (stock_item_id, change, reason, created_by)
select id,
       0,
       'Retired — Wix product renamed Women''s Training Top with sizes JNR8-JNR16, L6-L18',
       'WIX-RECONCILE'
  from stock_items
 where name = 'Girl''s and Women''s Training Top'
   and size = 'One size'
   and retired_at is null;

alter table stock_items disable trigger check_stock_item_update;

update stock_items
   set retired_at = now(),
       updated_at = now()
 where name = 'Girl''s and Women''s Training Top'
   and size = 'One size'
   and retired_at is null;

alter table stock_items enable trigger check_stock_item_update;
