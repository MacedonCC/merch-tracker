-- Give the pants, hat and beanie products categories of their own.
--
-- Both Coloured Playing Pants products and the retired pre-2026 line
-- were sitting in "Other" alongside Club Beanie, which made the Stock
-- page's category filter useless for the largest group of items. Broad
-- Rim Playing Hat was filed under "Cap", which is close but wrong - it
-- is a wide-brim sun hat, not a cap, and they are ordered separately.
--
-- Social Hat stays under Cap deliberately: it is a cap-style hat and is
-- bought with the caps. Only the broad-rim is moving.
--
-- Category is an identity column, so check_stock_item_update blocks it
-- for non-admins and raises without a JWT. Same trigger workaround as
-- migrations 20260920000002, 5, 6 and 8.

alter table stock_items disable trigger check_stock_item_update;

update stock_items
   set category = 'Pants', updated_at = now()
 where name in (
   'Men''s One Day Coloured Playing Pants',
   'Women''s One Day Coloured Playing Pants',
   'One Day Coloured Playing Pants (pre-2026)'
 );

update stock_items
   set category = 'Hat', updated_at = now()
 where name = 'Broad Rim Playing Hat';

update stock_items
   set category = 'Beanie', updated_at = now()
 where name = 'Club Beanie';

alter table stock_items enable trigger check_stock_item_update;
