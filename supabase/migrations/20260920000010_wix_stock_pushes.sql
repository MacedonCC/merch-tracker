-- Log of every quantity the tracker has pushed to the Wix shop.
--
-- Two jobs, and the second is the reason this exists at all rather than
-- being a debug aid:
--
-- 1. An audit trail. Pushing sets Wix inventory from the tracker's
--    `available`, so a wrong number takes a size off sale. When someone
--    asks why a shirt vanished from the shop, this says what was sent,
--    when, and by whom.
--
-- 2. Measuring suppressed demand. Once a size is blocked at zero nobody
--    can buy it, so it records no sales, so next season's restock
--    projection reads zero demand and blocks it again - a feedback loop
--    that quietly kills a size. The demand itself is unrecoverable, but
--    the suppression is measurable: from this log /restock can say
--    "sold 2, but blocked 140 of 210 days" instead of presenting the 2
--    as if the size had been on sale throughout.
--
-- `quantity` is what we sent (never negative - an oversold line clamps
-- to 0). `previous_quantity` is what Wix held immediately before, so a
-- row shows the change rather than just the destination. Both are kept
-- even when ok = false, because a failed push is exactly when you want
-- to know what was attempted.
--
-- Nothing reads this table yet; the restock annotation comes later.

create table if not exists wix_stock_pushes (
  id                uuid primary key default gen_random_uuid(),
  stock_item_id     uuid references stock_items(id) on delete set null,
  wix_product_id    text,
  wix_variant_id    text,
  quantity          integer not null,
  previous_quantity integer,
  ok                boolean not null default true,
  error             text,
  -- 'cron' (after the daily wix-sync) or 'manual' (the Stock page
  -- button). Distinguishes a routine push from someone forcing one.
  source            text not null default 'cron',
  pushed_by         text,
  pushed_at         timestamptz not null default now()
);

create index if not exists wix_stock_pushes_item_idx
  on wix_stock_pushes (stock_item_id, pushed_at desc);
create index if not exists wix_stock_pushes_at_idx
  on wix_stock_pushes (pushed_at desc);

alter table wix_stock_pushes enable row level security;

-- Committee members can read the log; it is written only by the
-- service-role client inside the push route, which bypasses RLS. No
-- insert/update/delete policy exists on purpose, so nothing reachable
-- through the browser can forge or rewrite a push record.
drop policy if exists "wix pushes read" on wix_stock_pushes;
create policy "wix pushes read" on wix_stock_pushes
  for select using (is_committee_member());
