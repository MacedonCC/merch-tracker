-- Retire the five junior sizes of "Men's One Day Playing Shirt".
--
-- They were never men's sizes. The club has re-listed them in Wix as a
-- separate unisex product, "Juniors Coloured Playing Shirts Short
-- Sleeve (Unisex)", and removed the JNR options from the men's product.
-- The garments themselves have not moved anywhere - the same 25 shirts
-- are in the same cupboard - but they are now sold under a different
-- line, so the stock has to follow them.
--
-- WHY THE STOCK IS MOVED OUT RATHER THAN LEFT ON THE RETIRED ROWS.
-- retired_at only tells /restock to stop ordering a line; it does not
-- make its quantity stop counting. Leaving 25 units on these rows would
-- double-count the club's shirts the moment the Juniors lines are given
-- the same 25 units from the Wix stocktake, and every catalogue total
-- would be 25 too high with nothing on screen to explain it.
--
-- The counts confirm the move rather than assume it. Wix reports the
-- new Juniors product holding JNR8 2, JNR10 5, JNR12 9, JNR14 9 - size
-- for size what these rows hold today. The follow-up migration writes
-- those counts onto the new lines; this one takes them off the old.
--
-- SAFE TO ZERO because none of these five lines has ever carried an
-- order: no history is stranded and nothing is committed against them.
-- That is also why clearing wix_variant_id below costs nothing -
-- wix-sync has no past order to re-match, and the ids are dead anyway.
--
-- JNR16 was already at 0 and gets a zero-change movement row rather
-- than none. A retirement with no trail reads later as a line that
-- simply stopped being mentioned; migration 20260920000001 set the
-- same precedent for "no stock moved" rows.
--
-- WIX VARIANT IDS ARE CLEARED. Editing a product's size options in Wix
-- regenerates its variant ids, so all five of these now point at
-- variants that no longer exist - they are 5 of the 11 entries in
-- wix-import's staleVariantIds report. Left in place they would sit in
-- that report forever, and a report that always has known noise in it
-- is a report nobody reads. wix_product_id is deliberately kept: the
-- men's product still exists, and eleven other rows share that id, so
-- wix-import's product-id fallback (which only fires when exactly one
-- row holds an id) can never bind a catalogue entry to a retired row.
--
-- TRIGGER WORKAROUND: check_stock_item_update resolves the caller with
-- auth.jwt() and raises when there is no JWT at all, and this changes
-- quantity, retired_at and wix_variant_id - none of which fall under
-- the service-role catalogue exemption. Disabled for the one statement,
-- as migrations 20260920000002, 20260920000006 and 20260920000012 did.
-- The ALTER holds an ACCESS EXCLUSIVE lock until commit.

-- The audit trail first, while the rows still say what they held.
insert into stock_movements (stock_item_id, change, reason, created_by)
select id,
       -quantity,
       'Retired — size moved to Juniors Coloured Playing Shirts Short Sleeve (Unisex)',
       'WIX-RECONCILE'
  from stock_items
 where name = 'Men''s One Day Playing Shirt'
   and size in ('JNR8', 'JNR10', 'JNR12', 'JNR14', 'JNR16')
   and retired_at is null;

alter table stock_items disable trigger check_stock_item_update;

update stock_items
   set quantity = 0,
       wix_variant_id = null,
       retired_at = now(),
       updated_at = now()
 where name = 'Men''s One Day Playing Shirt'
   and size in ('JNR8', 'JNR10', 'JNR12', 'JNR14', 'JNR16')
   and retired_at is null;

alter table stock_items enable trigger check_stock_item_update;
