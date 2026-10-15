-- Extend the 20261015000003 group backfill to completed (Done: paid and
-- handed over) orders, which it deliberately left out: JNR sizes go to
-- juniors, everything else stays unassigned. Only rows still unassigned
-- are touched, so a group anyone has already chosen is kept. Checked
-- before applying: 100 Done JNR orders, all unassigned.
--
-- A label only. check_order_update() needs a caller on every UPDATE, so
-- this runs as an admin; distributed_at is not touched, so no stock
-- moves.

select set_config('request.jwt.claims', '{"email":"juniorsmcc@gmail.com"}', true);

update orders o
   set order_group = 'juniors'
  from stock_items s
 where s.id = o.stock_item_id
   and s.size ilike 'JNR%'
   and o.order_group is null
   and o.payment_status = 'paid'
   and o.distributed_at is not null;

select set_config('request.jwt.claims', '', true);
