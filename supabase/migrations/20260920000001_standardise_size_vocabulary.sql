-- Standardise the size vocabulary on stock_items.
--
-- stock_items mirrored whatever vocabulary Wix used per product, so the
-- same physical size appeared under two spellings: Small/S, Medium/M,
-- Large/L, and "one size fits all"/"One size". That splits one size
-- across two rows in any grouping or report. This renames the long
-- forms to the short canonical ones, matching case-insensitively and
-- trimming surrounding whitespace.
--
-- Checked before writing this: no product ends up with two rows sharing
-- the same (name, size) after the rename, so nothing needs merging and
-- the stock_items_name_size_key unique constraint holds throughout. No
-- stock lines are combined here and no orders or movements are
-- reassigned — this is a pure rename.
--
-- check_stock_item_update is disabled for the duration. It resolves the
-- caller via auth.jwt() ->> 'email' and raises 'Not authorised to update
-- stock items.' when there is no JWT, which is always the case for a
-- migration. Disabling it is preferred over impersonating an admin
-- because there is no human actor to attribute this to. The ALTER holds
-- an ACCESS EXCLUSIVE lock until commit, so no concurrent write can slip
-- through unchecked.

alter table stock_items disable trigger check_stock_item_update;

with canon as (
  select id,
         size as old_size,
         case lower(trim(size))
           when 'small'             then 'S'
           when 'medium'            then 'M'
           when 'large'             then 'L'
           when 'one size fits all' then 'One size'
           else trim(size)
         end as new_size
    from stock_items
),
renamed as (
  update stock_items s
     set size = c.new_size,
         updated_at = now()
    from canon c
   where s.id = c.id
     and s.size is distinct from c.new_size
  returning s.id, c.old_size, c.new_size
)
insert into stock_movements (stock_item_id, change, reason, created_by)
select id,
       0,
       'Size vocabulary standardised: "' || old_size || '" renamed to "'
         || new_size || '" — name only, no stock moved',
       'MIGRATION'
  from renamed;

alter table stock_items enable trigger check_stock_item_update;
