-- Backfill orders.wix_order_number (added in 20261015000004) from the
-- note wix-sync has always written from Wix's own order number
-- ("Wix order #10179", or "Wix order #10179, paid online by ..." on a
-- merged /sell order). Checked before applying: 357 rows, every one
-- with exactly one number in its note, none already filled.
--
-- Display only. check_order_update() needs a caller on every UPDATE,
-- so this runs as an admin; distributed_at is not touched, so no stock
-- moves.

select set_config('request.jwt.claims', '{"email":"juniorsmcc@gmail.com"}', true);

update orders
   set wix_order_number = substring(notes from '#([0-9]+)')
 where wix_order_id is not null
   and wix_order_number is null
   and notes ~ '#[0-9]+';

select set_config('request.jwt.claims', '', true);
