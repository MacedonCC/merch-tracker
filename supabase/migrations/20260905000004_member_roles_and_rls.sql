-- ---------------------------------------------------------------
-- migration-004: two effective roles (admin / helper) + RLS
--
-- admin   = full access
-- helper  = can record orders, mark paid, hand over — cannot
--           insert/update/delete stock_items (so no adding or
--           removing stock items, no price changes, no target
--           level changes)
--
-- Existing 'treasurer' and 'viewer' rows are folded into 'helper'.
-- ---------------------------------------------------------------

update members set role = 'helper' where role in ('treasurer', 'viewer');

alter table members drop constraint if exists members_role_check;
alter table members
  add constraint members_role_check check (role in ('admin', 'helper'));
alter table members alter column role set default 'helper';

comment on column members.role is 'admin = full access, helper = can record orders, mark paid, hand over — cannot manage stock items';

-- ---------------------------------------------------------------
-- Helper function: is the current signed-in user an admin?
-- ---------------------------------------------------------------
create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from members
    where lower(email) = lower(auth.jwt() ->> 'email')
      and role = 'admin'
  );
$$;

-- ---------------------------------------------------------------
-- stock_items: both roles can read, only admins can write
-- ---------------------------------------------------------------
drop policy if exists "stock full access" on stock_items;

drop policy if exists "stock read" on stock_items;
create policy "stock read" on stock_items
  for select using (is_committee_member());

drop policy if exists "stock admin insert" on stock_items;
create policy "stock admin insert" on stock_items
  for insert with check (is_admin());

drop policy if exists "stock admin update" on stock_items;
create policy "stock admin update" on stock_items
  for update using (is_admin()) with check (is_admin());

drop policy if exists "stock admin delete" on stock_items;
create policy "stock admin delete" on stock_items
  for delete using (is_admin());

-- ---------------------------------------------------------------
-- orders: unchanged — both roles record orders, mark paid, hand over
-- ("orders full access" from schema.sql already covers this)
-- ---------------------------------------------------------------

-- ---------------------------------------------------------------
-- members: everyone on the committee can read the list, only
-- admins can add, change roles, or remove members
-- ---------------------------------------------------------------
drop policy if exists "members admin insert" on members;
create policy "members admin insert" on members
  for insert with check (is_admin());

drop policy if exists "members admin update" on members;
create policy "members admin update" on members
  for update using (is_admin()) with check (is_admin());

drop policy if exists "members admin delete" on members;
create policy "members admin delete" on members
  for delete using (is_admin());

-- ---------------------------------------------------------------
-- stock_overview is a view, so by default it runs with the owner's
-- privileges and bypasses RLS on stock_items entirely. Make it run
-- as the calling user so helpers only ever see what "stock read"
-- allows them to see.
-- ---------------------------------------------------------------
alter view stock_overview set (security_invoker = on);

-- ---------------------------------------------------------------
-- stock_movements had a read policy but no insert policy, so the
-- manual-adjustment logging in Tracker.tsx (saveItem) was being
-- silently denied. Any committee member can log a movement.
-- ---------------------------------------------------------------
drop policy if exists "movements insert" on stock_movements;
create policy "movements insert" on stock_movements
  for insert with check (is_committee_member());
