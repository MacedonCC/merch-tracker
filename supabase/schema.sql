-- Merchandise Tracker — database schema
-- Run this once in the Supabase SQL Editor (see README step 3).

-- ---------------------------------------------------------------
-- 1. Committee members allowed to use the app
-- ---------------------------------------------------------------
create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  full_name text,
  role text not null default 'viewer' check (role in ('admin', 'treasurer', 'viewer')),
  created_at timestamptz not null default now()
);

comment on table members is 'Committee members. Only emails listed here can sign in.';
comment on column members.role is 'admin = full access, treasurer = can mark payments, viewer = read only';

-- ---------------------------------------------------------------
-- 2. Stock items (one row per item + size combination)
-- ---------------------------------------------------------------
create table if not exists stock_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'Other',
  size text not null default 'One size',
  price numeric(10,2) not null default 0,
  quantity integer not null default 0 check (quantity >= 0),
  low_stock_alert integer not null default 5,
  wix_product_id text,
  wix_variant_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name, size)
);

comment on column stock_items.wix_product_id is 'Links this row to a product in the Wix store so sales can decrement it.';

create index if not exists stock_items_wix_idx on stock_items (wix_product_id, wix_variant_id);

-- ---------------------------------------------------------------
-- 3. Orders — who ordered, whether they paid, when they got it
-- ---------------------------------------------------------------
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  reference text unique not null default 'ORD-' || upper(substr(md5(random()::text), 1, 6)),
  customer_name text not null,
  customer_email text,
  stock_item_id uuid references stock_items(id) on delete set null,
  quantity integer not null default 1 check (quantity > 0),
  unit_price numeric(10,2) not null default 0,
  payment_status text not null default 'pending'
    check (payment_status in ('pending', 'paid', 'refunded')),
  distributed_at timestamptz,
  source text not null default 'manual' check (source in ('manual', 'wix')),
  wix_order_id text unique,
  notes text,
  ordered_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on column orders.source is 'manual = entered by committee, wix = pulled from the online shop.';
comment on column orders.wix_order_id is 'Unique, so re-running a sync cannot create duplicate orders.';

create index if not exists orders_status_idx on orders (payment_status);
create index if not exists orders_item_idx on orders (stock_item_id);

-- ---------------------------------------------------------------
-- 4. Stock movement log — an audit trail of every change
-- ---------------------------------------------------------------
create table if not exists stock_movements (
  id uuid primary key default gen_random_uuid(),
  stock_item_id uuid references stock_items(id) on delete cascade,
  change integer not null,
  reason text not null,
  order_id uuid references orders(id) on delete set null,
  created_by text,
  created_at timestamptz not null default now()
);

comment on table stock_movements is 'Every stock change is recorded here so you can always explain a number.';

-- ---------------------------------------------------------------
-- 5. Automatically reduce stock when an order is created
-- ---------------------------------------------------------------
create or replace function handle_new_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.stock_item_id is not null then
    update stock_items
      set quantity = greatest(0, quantity - new.quantity),
          updated_at = now()
      where id = new.stock_item_id;

    insert into stock_movements (stock_item_id, change, reason, order_id)
      values (new.stock_item_id, -new.quantity, 'Order ' || new.reference, new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists on_order_created on orders;
create trigger on_order_created
  after insert on orders
  for each row execute function handle_new_order();

-- ---------------------------------------------------------------
-- 6. Return stock if an order is deleted
-- ---------------------------------------------------------------
create or replace function handle_deleted_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.stock_item_id is not null then
    update stock_items
      set quantity = quantity + old.quantity,
          updated_at = now()
      where id = old.stock_item_id;

    insert into stock_movements (stock_item_id, change, reason)
      values (old.stock_item_id, old.quantity, 'Order ' || old.reference || ' removed');
  end if;
  return old;
end;
$$;

drop trigger if exists on_order_deleted on orders;
create trigger on_order_deleted
  after delete on orders
  for each row execute function handle_deleted_order();

-- ---------------------------------------------------------------
-- 7. Security — only signed-in committee members can read or write
-- ---------------------------------------------------------------
alter table members enable row level security;
alter table stock_items enable row level security;
alter table orders enable row level security;
alter table stock_movements enable row level security;

create or replace function is_committee_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from members
    where lower(email) = lower(auth.jwt() ->> 'email')
  );
$$;

drop policy if exists "members read" on members;
create policy "members read" on members
  for select using (is_committee_member());

drop policy if exists "stock full access" on stock_items;
create policy "stock full access" on stock_items
  for all using (is_committee_member()) with check (is_committee_member());

drop policy if exists "orders full access" on orders;
create policy "orders full access" on orders
  for all using (is_committee_member()) with check (is_committee_member());

drop policy if exists "movements read" on stock_movements;
create policy "movements read" on stock_movements
  for select using (is_committee_member());

-- ---------------------------------------------------------------
-- 8. Handy view: current stock with a status label
-- ---------------------------------------------------------------
create or replace view stock_overview as
  select
    s.*,
    case
      when s.quantity = 0 then 'out'
      when s.quantity <= s.low_stock_alert then 'low'
      else 'ok'
    end as stock_status,
    (s.quantity * s.price) as stock_value
  from stock_items s;

-- ---------------------------------------------------------------
-- 9. FIRST-TIME SETUP — add yourself so you can sign in
--    Replace the email below with your own, then run this file.
-- ---------------------------------------------------------------
insert into members (email, full_name, role)
  values ('your-email@gmail.com', 'Your Name', 'admin')
  on conflict (email) do nothing;
