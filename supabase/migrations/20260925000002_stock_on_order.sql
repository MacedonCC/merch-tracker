-- Enter a delivery that has been ordered but has not physically arrived.
--
-- 31 lines, +127 units, taking the catalogue from 206 to 333. The
-- committee wants the gear sellable online and at the ground straight
-- away rather than waiting for the boxes, so the counts go in now and
-- the stock_movements rows carry the caveat.
--
-- THIS IS NOT A STOCKTAKE. Every other bulk write in this repo records
-- something that is in the cupboard: migration 20260922000002
-- transcribed a physical count, 20260922000001 moved real garments
-- between lines. This one deliberately records stock the club does not
-- yet hold, which is a different thing and has to stay legible as one.
-- That is what created_by = 'ON-ORDER' is for - a new marker rather
-- than one of the existing ones, so the whole batch comes back from a
-- single query when the delivery lands:
--
--   select si.name, si.size, sm.change
--     from stock_movements sm
--     join stock_items si on si.id = sm.stock_item_id
--    where sm.created_by = 'ON-ORDER';
--
-- Correcting a short delivery is then a matching adjustment against
-- that list, not an attempt to reconstruct which of today's numbers
-- were real.
--
-- ADDITIVE, NOT A REPLACEMENT. quantity = quantity + n. Nine of the 31
-- lines already hold stock (the Playing Cap alone holds 16), and
-- writing the delivery quantities as absolute values would silently
-- destroy those counts. The 16 polo lines wix-import created this
-- morning are all at 0, so for them the two are the same, but the
-- shape has to be right for the other nine.
--
-- THE MOVEMENTS ARE DERIVED FROM THE UPDATE, not written alongside it.
-- One data-modifying statement updates the rows and feeds its RETURNING
-- into the stock_movements insert, so the audit trail cannot drift from
-- what was actually written - a movement row exists if and only if a
-- quantity moved. Migration 20260920000001 set the same pattern.
--
-- WHAT THIS DOES TO THE ORDERS QUEUE. Three paid orders flip from
-- "waiting on stock" to "Ready" and will appear under "Hand over all":
-- Zac Waddington (Men's White Playing Shirt / L), Ollie Neilsen
-- (Training Shorts / JNR12) and Jane Coleman (Training Shorts / M).
-- The tracker will say their gear is collectable before it is in the
-- building. That follows unavoidably from entering undelivered stock
-- and was accepted deliberately; it is written down here because the
-- next person to read this file will want to know it was foreseen.
--
-- MEN'S WHITE PLAYING SHIRT / L STAYS OVERSOLD at -2. It holds 0
-- against 4 committed and gains 2. Cameron Howlett's order of 3 from
-- 27 Aug is not settled by this delivery and stays Waiting; Zac
-- Waddington's single unit from 2 Sep goes Ready ahead of it, which is
-- correct - classifyOrders() allocates oldest first but a waiting order
-- does not consume stock it cannot use. If the delivery was meant to
-- clear Cameron, this line needed +5.
--
-- THE NEXT WIX PUSH SELLS ALL OF IT. WIX_PUSH_ENABLED is on and the
-- cron runs 09:00 UTC, so availability goes up tonight and the 16 new
-- polo lines have trackQuantity switched on in the same run. Between
-- that push and the delivery, the Wix shop can sell garments that are
-- not in the cupboard. Intended, and the reason this migration exists
-- rather than the counts waiting for the boxes.
--
-- THE BATCH IS HELD IN A TEMPORARY TABLE so the 31 lines are written
-- out exactly once. Repeating them for the guard and again for the
-- update would invite the two copies to disagree, which is the one
-- error a reviewer of a list this long is least likely to catch.
--
-- TRIGGER WORKAROUND: check_stock_item_update resolves the caller with
-- auth.jwt() and raises when there is no JWT at all, and quantity is
-- not covered by the service-role catalogue exemption migration
-- 20260920000007 opened. Disabled for the single statement, as
-- migrations 20260920000002, 20260920000006, 20260920000012 and
-- 20260922000001 did. The ALTER holds an ACCESS EXCLUSIVE lock until
-- commit, so no concurrent write escapes the check.

create temporary table on_order_batch (name text, size text, add int);

insert into on_order_batch (name, size, add) values
  ('Men''s White Playing Shirt',            'JNR10',    4),
  ('Men''s White Playing Shirt',            'JNR12',    5),
  ('Men''s White Playing Shirt',            'JNR14',    4),
  ('Men''s White Playing Shirt',            'JNR16',    7),
  ('Men''s White Playing Shirt',            'M',        2),
  ('Men''s White Playing Shirt',            'L',        2),
  ('Men''s White Playing Shirt',            'XL',       2),
  ('Training Shorts',                       'JNR12',    2),
  ('Training Shorts',                       'JNR14',    3),
  ('Training Shorts',                       'M',        3),
  ('Training Shorts',                       'L',        2),
  ('Broad Rim Playing Hat',                 'M',        5),
  ('Playing Cap (one size fits all)',       'One size', 20),
  ('Men''s Social Polo Shirt',              'S',        4),
  ('Men''s Social Polo Shirt',              'M',        8),
  ('Men''s Social Polo Shirt',              'L',        7),
  ('Men''s Social Polo Shirt',              'XL',       6),
  ('Men''s Social Polo Shirt',              '2XL',      3),
  ('Men''s Social Polo Shirt',              '3XL',      2),
  ('Women''s Social Polo Shirt',            'L6',       1),
  ('Women''s Social Polo Shirt',            'L8',       1),
  ('Women''s Social Polo Shirt',            'L10',      2),
  ('Women''s Social Polo Shirt',            'L12',      2),
  ('Women''s Social Polo Shirt',            'L14',      2),
  ('Women''s Social Polo Shirt',            'L16',      1),
  ('Women''s Social Polo Shirt',            'L18',      1),
  ('Men''s One Day Coloured Playing Pants', 'S',        4),
  ('Men''s One Day Coloured Playing Pants', 'M',        8),
  ('Men''s One Day Coloured Playing Pants', 'L',        8),
  ('Men''s One Day Coloured Playing Pants', 'XL',       4),
  ('Men''s One Day Coloured Playing Pants', '2XL',      2);

-- Prove the batch resolves before writing any of it. Checked here
-- rather than asserted in a comment: a typo in one of 31 size strings
-- would otherwise write 30 lines and drop the thirty-first without
-- complaint, and a silent partial delivery is worse than none. A
-- retired line counts as no match rather than being updated quietly -
-- stock must not be added to a line no screen will show.
do $$
declare
  bad text;
  n   int;
begin
  select string_agg(b.name || ' / ' || b.size || ' (' || b.matched || ' live rows)',
                    ', ' order by b.name, b.size)
    into bad
    from (
      select o.name,
             o.size,
             count(s.id) filter (where s.retired_at is null) as matched
        from on_order_batch o
        left join stock_items s on s.name = o.name and s.size = o.size
       group by o.name, o.size
    ) b
   where b.matched <> 1;

  if bad is not null then
    raise exception
      'Stock entry aborted: these lines do not resolve to exactly one live row: %', bad;
  end if;

  select count(*) into n from on_order_batch;
  if n <> 31 then
    raise exception 'Stock entry aborted: expected 31 lines, batch holds %', n;
  end if;
end $$;

alter table stock_items disable trigger check_stock_item_update;

with moved as (
  update stock_items s
     set quantity = s.quantity + o.add,
         updated_at = now()
    from on_order_batch o
   where s.name = o.name
     and s.size = o.size
     and s.retired_at is null
  returning s.id, o.add
)
insert into stock_movements (stock_item_id, change, reason, created_by)
select id, add, 'Ordered, not yet delivered', 'ON-ORDER'
  from moved;

alter table stock_items enable trigger check_stock_item_update;

drop table on_order_batch;
