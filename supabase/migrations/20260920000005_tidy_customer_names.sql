-- One-off cleanup of stray whitespace in orders.customer_name.
--
-- Wix stores first and last names with their own trailing spaces, so
-- joining them produced "Ollie  Neilsen"; hand-entered names picked up
-- trailing spaces from phone keyboards. The result is that one person
-- appears as several entries in the /sell type-ahead and their orders
-- group separately on the Orders page.
--
-- 57 orders across 23 distinct names are affected. Four people are
-- currently split across a tidy and an untidy spelling and will merge
-- back into one: Cameron Howlett, Jane Coleman, Sarah Loughlin and
-- Scott McCann.
--
-- Going forward both write paths normalise through tidyName() in
-- lib/types.ts (app/api/wix-sync/route.ts and components/SellFlow.tsx),
-- so this is a backfill, not a recurring fix.
--
-- TRIGGER WORKAROUND: check_order_update (BEFORE UPDATE on orders)
-- resolves the caller via auth.jwt() ->> 'email' and raises
-- 'Not authorised to update orders.' when there is no JWT, which is
-- always true inside a migration. It is disabled for this one
-- statement, the same approach migration 20260920000002 used for its
-- payment_method backfill. The ALTER holds an ACCESS EXCLUSIVE lock
-- until commit, so no concurrent write escapes the check.
--
-- on_distribution_change is deliberately left ENABLED. It only acts on
-- a distributed_at transition and this statement touches customer_name
-- alone, so no stock moves and no stock_movements rows are written —
-- leaving it armed means that if this did somehow touch a handover,
-- the audit trail would say so rather than staying silent.

alter table orders disable trigger check_order_update;

update orders
   set customer_name = regexp_replace(btrim(customer_name), '\s+', ' ', 'g')
 where customer_name is not null
   and customer_name is distinct from regexp_replace(btrim(customer_name), '\s+', ' ', 'g');

alter table orders enable trigger check_order_update;
