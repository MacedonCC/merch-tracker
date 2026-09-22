-- Enter two physical counts that were taken in Wix rather than here.
--
-- The committee counted the cupboard and typed the numbers straight
-- into Wix stock levels: the MCC Senior Baggy Cap (six sizes, 14 units)
-- and the new Juniors Coloured Playing Shirts Short Sleeve (Unisex)
-- product (25 units). Both lines read 0 in the tracker, which is wrong
-- in the ordinary way a count is wrong - nobody had entered it - not
-- because any sale or handover went unrecorded.
--
-- THIS IS NOT A WIX STOCK PULL and must not become the first step of
-- one. It is a one-off transcription of a count that happened to be
-- typed somewhere else. Wix normally holds `available`
-- (on_hand - committed, clamped at zero) pushed FROM this tracker, so
-- reading quantities back from it as a matter of routine would feed
-- the tracker's own arithmetic back into itself and quietly lose every
-- committed order. Verified before writing: across the 84 lines where
-- both numbers are known, Wix agrees with max(0, available) on every
-- single one except these six caps - which is exactly the shape you
-- would expect if the only Wix-side edit was the cap count itself.
--
-- WHY THE JUNIORS NUMBERS ARE SAFE to take as a count: they are
-- 2/5/9/9, size for size what the retired Men's One Day JNR lines held
-- before migration 20260922000001 moved them out. The same 25 shirts,
-- recorded against the line that now sells them. The catalogue total
-- returns to where it started plus the 14 newly counted caps.
--
-- JNR16 IS DELIBERATELY ABSENT. Wix has the size but holds no
-- inventory record for it at all - wix-import reported wixQuantity
-- null with wixTracked true, which means "Wix did not say", not
-- "Wix says none". It stays at 0, which is also what it held before.
-- Writing a 0 here would log a count nobody took.
--
-- CATEGORY CORRECTION. wix-import created the five Juniors lines as
-- 'Shorts'. guessCategory() tests 'short' before 'shirt', and the Wix
-- product is called "...Playing Shirts Short Sleeve...", so the
-- broader word won - the same failure mode its own comment warns
-- about, newly reachable because no product name had contained "Short
-- Sleeve" until now. Corrected here rather than by changing
-- guessCategory, which was a deliberate call: the function is left as
-- it is, so a future short-sleeve product will need the same
-- correction. Each of the five gets a zero-change movement row, as
-- migration 20260920000001 did for its renames, so the difference
-- between what the import wrote and what is here now has a trail.
--
-- TRIGGER WORKAROUND: quantity and category are both outside the
-- service-role catalogue exemption and check_stock_item_update raises
-- without a JWT, so it is disabled across these statements - as
-- migrations 20260920000002, 20260920000006, 20260920000012 and
-- 20260922000001 did. The ALTER holds an ACCESS EXCLUSIVE lock until
-- commit.

-- The counts are spelled out in each statement rather than staged in
-- a temp table: `on commit drop` would take the table away mid-file if
-- this migration were ever run outside a single transaction, and a
-- half-applied stocktake is a worse failure than a repeated literal.

-- The trail first, while stock_items still holds the old figure.
insert into stock_movements (stock_item_id, change, reason, created_by)
select si.id, c.counted - si.quantity, 'Count entered in Wix', 'WIX-RECONCILE'
  from stock_items si
  join (values
    ('MCC Senior Baggy Cap', 'S', 2),
    ('MCC Senior Baggy Cap', 'M', 2),
    ('MCC Senior Baggy Cap', 'L', 3),
    ('MCC Senior Baggy Cap', 'XL', 3),
    ('MCC Senior Baggy Cap', '2XL', 2),
    -- Wix spells this size "one size fits all"; the tracker
    -- standardised on "One size" in migration 20260920000001. Matched
    -- on the tracker's spelling, which nothing here changes.
    ('MCC Senior Baggy Cap', 'One size', 2),
    ('Juniors Coloured Playing Shirts Short Sleeve (Unisex)', 'JNR8', 2),
    ('Juniors Coloured Playing Shirts Short Sleeve (Unisex)', 'JNR10', 5),
    ('Juniors Coloured Playing Shirts Short Sleeve (Unisex)', 'JNR12', 9),
    ('Juniors Coloured Playing Shirts Short Sleeve (Unisex)', 'JNR14', 9)
  ) as c(name, size, counted)
    on c.name = si.name and c.size = si.size
 where si.quantity is distinct from c.counted;

insert into stock_movements (stock_item_id, change, reason, created_by)
select si.id, 0,
       'Category corrected to T-Shirt — wix-import read "Short Sleeve" as Shorts',
       'WIX-RECONCILE'
  from stock_items si
 where si.name = 'Juniors Coloured Playing Shirts Short Sleeve (Unisex)'
   and si.category is distinct from 'T-Shirt';

alter table stock_items disable trigger check_stock_item_update;

update stock_items si
   set quantity = c.counted,
       updated_at = now()
  from (values
    ('MCC Senior Baggy Cap', 'S', 2),
    ('MCC Senior Baggy Cap', 'M', 2),
    ('MCC Senior Baggy Cap', 'L', 3),
    ('MCC Senior Baggy Cap', 'XL', 3),
    ('MCC Senior Baggy Cap', '2XL', 2),
    -- Wix spells this size "one size fits all"; the tracker
    -- standardised on "One size" in migration 20260920000001. Matched
    -- on the tracker's spelling, which nothing here changes.
    ('MCC Senior Baggy Cap', 'One size', 2),
    ('Juniors Coloured Playing Shirts Short Sleeve (Unisex)', 'JNR8', 2),
    ('Juniors Coloured Playing Shirts Short Sleeve (Unisex)', 'JNR10', 5),
    ('Juniors Coloured Playing Shirts Short Sleeve (Unisex)', 'JNR12', 9),
    ('Juniors Coloured Playing Shirts Short Sleeve (Unisex)', 'JNR14', 9)
  ) as c(name, size, counted)
 where c.name = si.name
   and c.size = si.size
   and si.quantity is distinct from c.counted;

update stock_items
   set category = 'T-Shirt',
       updated_at = now()
 where name = 'Juniors Coloured Playing Shirts Short Sleeve (Unisex)'
   and category is distinct from 'T-Shirt';

alter table stock_items enable trigger check_stock_item_update;
