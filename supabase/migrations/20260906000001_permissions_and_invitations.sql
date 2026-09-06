-- ---------------------------------------------------------------
-- migration-007: per-permission flags + invitations
--
-- Committee members are still 'admin' or 'helper', but a helper can
-- now be granted any combination of four flags:
--   can_adjust_stock   — change stock_items.quantity
--   can_change_prices  — change stock_items.price
--   can_change_targets — change low_stock_alert / target_level
--   can_undo_handover  — reverse orders.distributed_at back to null
--
-- Admins have all four implicitly, regardless of what the columns
-- say (enforced below in check_stock_item_update / check_order_update,
-- and mirrored in the app's effectivePermissions() helper).
-- ---------------------------------------------------------------

alter table members
  add column if not exists can_adjust_stock boolean not null default false,
  add column if not exists can_change_prices boolean not null default false,
  add column if not exists can_change_targets boolean not null default false,
  add column if not exists can_undo_handover boolean not null default false;

-- ---------------------------------------------------------------
-- Invitations — a pending invite is turned into a `members` row by
-- app/auth/callback/route.ts once the invitee signs in (see that
-- file); this table only records the offer.
-- ---------------------------------------------------------------
create table if not exists invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  role text not null default 'helper' check (role in ('admin', 'helper')),
  can_adjust_stock boolean not null default false,
  can_change_prices boolean not null default false,
  can_change_targets boolean not null default false,
  can_undo_handover boolean not null default false,
  invited_by text not null,
  invited_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked'))
);

comment on table invitations is 'Pending/accepted/revoked invites. Accepting one (in app/auth/callback) creates the members row.';

create index if not exists invitations_email_idx on invitations (lower(email));
create index if not exists invitations_status_idx on invitations (status);

alter table invitations enable row level security;

drop policy if exists "invitations admin all" on invitations;
create policy "invitations admin all" on invitations
  for all using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------
-- members: tighten read access. Previously any committee member
-- could read the whole roster; now only admins can, but everyone
-- can still read their own row (resolveViewer() depends on this to
-- tell "signed in, not on the list" apart from "signed in, is a
-- helper").
-- ---------------------------------------------------------------
drop policy if exists "members read" on members;

drop policy if exists "members read self" on members;
create policy "members read self" on members
  for select using (lower(email) = lower(auth.jwt() ->> 'email'));

drop policy if exists "members read all admin" on members;
create policy "members read all admin" on members
  for select using (is_admin());

-- members admin insert/update/delete policies from migration-004 are
-- unchanged — only admins can write to members.

-- ---------------------------------------------------------------
-- stock_items: RLS can only gate whole rows, not individual columns,
-- so the update policy now admits any committee member and a
-- trigger enforces which columns they're actually allowed to touch.
-- ---------------------------------------------------------------
drop policy if exists "stock admin update" on stock_items;
drop policy if exists "stock update" on stock_items;
create policy "stock update" on stock_items
  for update using (is_committee_member()) with check (is_committee_member());

create or replace function check_stock_item_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m members%rowtype;
begin
  select * into m from members where lower(members.email) = lower(auth.jwt() ->> 'email');

  if m.id is null then
    raise exception 'Not authorised to update stock items.';
  end if;

  if m.role = 'admin' then
    return new;
  end if;

  if new.quantity is distinct from old.quantity and not m.can_adjust_stock then
    raise exception 'Missing permission: can_adjust_stock';
  end if;

  if new.price is distinct from old.price and not m.can_change_prices then
    raise exception 'Missing permission: can_change_prices';
  end if;

  if (new.target_level is distinct from old.target_level
      or new.low_stock_alert is distinct from old.low_stock_alert)
     and not m.can_change_targets then
    raise exception 'Missing permission: can_change_targets';
  end if;

  if new.name is distinct from old.name
     or new.category is distinct from old.category
     or new.size is distinct from old.size
     or new.wix_product_id is distinct from old.wix_product_id
     or new.wix_variant_id is distinct from old.wix_variant_id then
    raise exception 'Only admins can change item name, category, size or Wix linking.';
  end if;

  return new;
end;
$$;

drop trigger if exists check_stock_item_update on stock_items;
create trigger check_stock_item_update
  before update on stock_items
  for each row execute function check_stock_item_update();

-- ---------------------------------------------------------------
-- orders: reversing a handover needs can_undo_handover. Everything
-- else on orders stays open to any committee member, same as before
-- ("orders full access" from schema.sql).
-- ---------------------------------------------------------------
create or replace function check_order_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m members%rowtype;
begin
  select * into m from members where lower(members.email) = lower(auth.jwt() ->> 'email');

  if m.id is null then
    raise exception 'Not authorised to update orders.';
  end if;

  if m.role = 'admin' then
    return new;
  end if;

  if old.distributed_at is not null and new.distributed_at is null and not m.can_undo_handover then
    raise exception 'Missing permission: can_undo_handover';
  end if;

  return new;
end;
$$;

drop trigger if exists check_order_update on orders;
create trigger check_order_update
  before update on orders
  for each row execute function check_order_update();
