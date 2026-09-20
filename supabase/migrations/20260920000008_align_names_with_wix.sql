-- Align tracker product names with their Wix names.
--
-- Products renamed in Wix keep their id, so an order still matches by
-- wix_variant_id and the daily sync is unaffected. The damage is to
-- wix-import's NAME fallback, which is the only thing that can match a
-- row holding no variant id — or one whose variant id Wix regenerated
-- when its size options were edited. When both happen at once the size
-- matches nothing, gets created as a new line, and its stock is
-- stranded on the old row.
--
-- That was not hypothetical: a dry run had
-- "Macedon Cricket Club One Day Playing Shirt" producing nine creates,
-- seven of which duplicated existing lines holding 31 units — the four
-- junior sizes (no variant id) plus S, M and L (variant ids
-- regenerated when Wix renamed those sizes from Small/Medium/Large).
--
-- Seven products, 49 rows. Verified beforehand that no target
-- (name, size) already exists, so the stock_items_name_size_key unique
-- constraint holds throughout. Only `name` changes.
--
-- Deliberately NOT renamed:
--   One Day Coloured Playing Pants (pre-2026) — retired, no Wix product
--   Social Polo Shirt                         — no Wix product
-- Seven further products already match Wix exactly.
--
-- Nothing else moves. Orders reference stock_items by id, so their
-- history follows the rename automatically and no order is repointed;
-- quantities, handovers and Wix links are untouched.
--
-- TRIGGER WORKAROUND: check_stock_item_update treats `name` as an
-- identity column, outside the catalogue exemption that migration
-- 20260920000007 opened, and raises without a JWT in any case.
-- Disabled for the single statement, as migrations 20260920000002,
-- 20260920000005 and 20260920000006 did. The ALTER holds an ACCESS
-- EXCLUSIVE lock until commit, so no concurrent write escapes the
-- check.

alter table stock_items disable trigger check_stock_item_update;

with renames(old_name, new_name) as (values
  ('Macedon Cricket Club One Day Playing Shirt',
   'Men''s One Day Playing Shirt'),
  ('Macedon Cricket Club One Day Playing Shirt - Long Sleeve',
   'Men''s One Day Playing Shirt - Long Sleeve'),
  ('Macedon White Playing Shirt',
   'Men''s White Playing Shirt'),
  ('Macedon White Playing Shirt - Long Sleeve',
   'Men''s White Playing Shirt - Long Sleeve'),
  ('Mens One Day Coloured Playing Pants',
   'Men''s One Day Coloured Playing Pants'),
  ('Womens One Day Coloured Playing Pants',
   'Women''s One Day Coloured Playing Pants'),
  ('Womens One Day Playing Shirt',
   'Women''s One Day Playing Shirt')
)
update stock_items s
   set name = r.new_name,
       updated_at = now()
  from renames r
 where s.name = r.old_name;

alter table stock_items enable trigger check_stock_item_update;
