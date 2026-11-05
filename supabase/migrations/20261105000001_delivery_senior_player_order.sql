-- Enter the senior player order that arrived on 5 Nov 2026.
--
-- 9 lines, +19 units. A separate order from the 25 Sep ON-ORDER batch
-- (20260925000002), confirmed by the committee, so the pants sizes it
-- shares with that batch are not double-counted. Checked beforehand
-- that none of it had been entered by hand.
--
-- ADDITIVE, NOT A REPLACEMENT: quantity = quantity + n, so the counts
-- already on these lines are kept. Every line gets its own
-- stock_movements row under created_by = 'DELIVERY', so the batch
-- comes back from one query:
--
--   select si.name, si.size, sm.change
--     from stock_movements sm
--     join stock_items si on si.id = sm.stock_item_id
--    where sm.reason = 'Delivery: senior player order (5 Nov)';
--
-- Same shape as 20260925000002: resolve every line to exactly one live
-- row before writing any of it, and bypass check_stock_item_update only
-- for the length of the write (there is no member JWT in a migration).

create temporary table delivery_batch (name text, size text, add int);

insert into delivery_batch (name, size, add) values
  ('Men''s One Day Playing Shirt',               'S',  1),
  ('Men''s One Day Playing Shirt',               'M',  3),
  ('Men''s One Day Playing Shirt',               'L',  3),
  ('Men''s One Day Playing Shirt',               'XL', 1),
  ('Men''s One Day Playing Shirt - Long Sleeve', 'M',  1),
  ('Men''s One Day Coloured Playing Pants',      'XS', 1),
  ('Men''s One Day Coloured Playing Pants',      'S',  1),
  ('Men''s One Day Coloured Playing Pants',      'M',  5),
  ('Men''s One Day Coloured Playing Pants',      'L',  3);

do $$
declare
  bad text;
  n   int;
begin
  select string_agg(b.name || ' / ' || b.size || ' (' || b.matched || ' live rows)',
                    ', ' order by b.name, b.size)
    into bad
    from (
      select d.name,
             d.size,
             count(s.id) filter (where s.retired_at is null) as matched
        from delivery_batch d
        left join stock_items s on s.name = d.name and s.size = d.size
       group by d.name, d.size
    ) b
   where b.matched <> 1;
  if bad is not null then
    raise exception
      'Delivery aborted: these lines do not resolve to exactly one live row: %', bad;
  end if;
  select count(*) into n from delivery_batch;
  if n <> 9 then
    raise exception 'Delivery aborted: expected 9 lines, batch holds %', n;
  end if;
end $$;

alter table stock_items disable trigger check_stock_item_update;

with moved as (
  update stock_items s
     set quantity = s.quantity + d.add,
         updated_at = now()
    from delivery_batch d
   where s.name = d.name
     and s.size = d.size
     and s.retired_at is null
  returning s.id, d.add
)
insert into stock_movements (stock_item_id, change, reason, created_by)
select id, add, 'Delivery: senior player order (5 Nov)', 'DELIVERY'
  from moved;

alter table stock_items enable trigger check_stock_item_update;

drop table delivery_batch;
