-- Retire the old combined pants line.
--
-- The Wix product it pointed at has been renamed to "Mens One Day
-- Coloured Playing Pants" and given size options, so this single
-- "One size" row is no longer how pants are sold. Its wix_product_id is
-- cleared so wix-sync stops matching new orders onto it, and the name
-- is dated so the row reads as deliberately historical rather than as a
-- duplicate of the Mens lines.
--
-- Its 7 historical orders (2023-10-30 to 2026-01-27, all handed over)
-- stay attached to it. They were placed against a product that had no
-- sizes at the time, so assigning them one would invent data and would
-- distort that size's demand in the restock projection. The row is kept
-- rather than deleted for the same reason: orders.stock_item_id is
-- ON DELETE SET NULL, so removing it would silently detach those orders
-- from any product.
--
-- Clearing the Wix link is also what keeps the rewritten wix-import off
-- this row: matching is by name + size, and no Wix product is called
-- "One Day Coloured Playing Pants (pre-2026)".
--
-- TRIGGER WORKAROUND: check_stock_item_update raises without a JWT, and
-- this changes name and wix_product_id, which are identity columns
-- outside any exemption. Disabled for the one statement, as migrations
-- 20260920000002 and 20260920000005 did. The ALTER holds an ACCESS
-- EXCLUSIVE lock until commit.

alter table stock_items disable trigger check_stock_item_update;

update stock_items
   set name = 'One Day Coloured Playing Pants (pre-2026)',
       wix_product_id = null,
       wix_variant_id = null,
       updated_at = now()
 where name = 'One Day Coloured Playing Pants'
   and size = 'One size';

alter table stock_items enable trigger check_stock_item_update;
