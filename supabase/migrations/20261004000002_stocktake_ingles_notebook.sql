-- Enter a physical stocktake taken from Ingles's notebook, counted
-- around 1 Oct, for seven lines across two products.
--
-- THESE ARE ABSOLUTE COUNTS, not adjustments. The notebook says what
-- is in the cupboard today; quantity is set TO that figure rather than
-- moved BY a delta, same as migration 20260922000002's Wix counts.
--
-- Women's One Day Coloured Playing Pants: S 0->1, L 0->2, 2XL 3->2,
-- JNR8 2->1. Men's One Day Playing Shirt: L 1->2, XL 2->1, 3XL 0->1.
-- Net change across the seven lines is +2 (+1+2-1-1+1-1+1).
--
-- NOTHING ELSE MOVES. No other stock_items row, no target_level/price/
-- category, no orders row, and no touch to the on-order batch from
-- migration 20260925000002 — different product/size cells entirely,
-- and this migration only ever names the seven above.
--
-- TRIGGER WORKAROUND: quantity sits outside the service-role catalogue
-- exemption and check_stock_item_update raises without a JWT in a
-- plain SQL session, so it is disabled across the single UPDATE below,
-- as migrations 20260920000002, 20260920000006, 20260920000012,
-- 20260922000001, 20260922000002 and 20260925000002 did. The ALTER
-- holds an ACCESS EXCLUSIVE lock until commit, so no concurrent write
-- escapes the check.
--
-- The counts are spelled out in each statement rather than staged in a
-- temp table, same reasoning as migration 20260922000002: a half-
-- applied stocktake is a worse failure than a repeated literal.

-- The trail first, while stock_items still holds the old figure.
insert into stock_movements (stock_item_id, change, reason, created_by)
select si.id, c.counted - si.quantity, 'Stocktake, Ingles notebook', 'STOCKTAKE'
  from stock_items si
  join (values
    ('Women''s One Day Coloured Playing Pants', 'S',    1),
    ('Women''s One Day Coloured Playing Pants', 'L',    2),
    ('Women''s One Day Coloured Playing Pants', '2XL',  2),
    ('Women''s One Day Coloured Playing Pants', 'JNR8', 1),
    ('Men''s One Day Playing Shirt',             'L',    2),
    ('Men''s One Day Playing Shirt',             'XL',   1),
    ('Men''s One Day Playing Shirt',             '3XL',  1)
  ) as c(name, size, counted)
    on c.name = si.name and c.size = si.size
 where si.retired_at is null
   and si.quantity is distinct from c.counted;

alter table stock_items disable trigger check_stock_item_update;

update stock_items si
   set quantity = c.counted,
       updated_at = now()
  from (values
    ('Women''s One Day Coloured Playing Pants', 'S',    1),
    ('Women''s One Day Coloured Playing Pants', 'L',    2),
    ('Women''s One Day Coloured Playing Pants', '2XL',  2),
    ('Women''s One Day Coloured Playing Pants', 'JNR8', 1),
    ('Men''s One Day Playing Shirt',             'L',    2),
    ('Men''s One Day Playing Shirt',             'XL',   1),
    ('Men''s One Day Playing Shirt',             '3XL',  1)
  ) as c(name, size, counted)
 where c.name = si.name
   and c.size = si.size
   and si.retired_at is null
   and si.quantity is distinct from c.counted;

alter table stock_items enable trigger check_stock_item_update;
