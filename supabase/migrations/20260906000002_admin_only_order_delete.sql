-- ---------------------------------------------------------------
-- migration-008: restrict deleting an order to admins
--
-- "orders full access" (schema.sql) let any committee member do
-- anything to orders, including delete. The Orders page now exposes
-- Remove behind an admin-only "..." menu — enforce that server-side
-- too, not just by hiding the button, same as every other permission
-- in this app.
-- ---------------------------------------------------------------

drop policy if exists "orders full access" on orders;

create policy "orders read" on orders
  for select using (is_committee_member());

create policy "orders insert" on orders
  for insert with check (is_committee_member());

create policy "orders update" on orders
  for update using (is_committee_member()) with check (is_committee_member());

create policy "orders admin delete" on orders
  for delete using (is_admin());
