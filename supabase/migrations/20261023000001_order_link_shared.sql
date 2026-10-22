-- Records that a payment link went out by text instead of email: the
-- Orders row "Copy payment message" / "Share…" actions and the same two
-- buttons on the /sell done screen. Shown on Orders as "Link copied
-- 23/10" or "Link shared 23/10", alongside the email result.
--
-- No trigger change needed, for the same reason as email_sent_at
-- (migration 20261008000001): check_order_update() only gates clearing
-- distributed_at, so any committee member can write these.
alter table orders
  add column if not exists link_shared_at timestamptz,
  add column if not exists link_shared_via text
    check (link_shared_via in ('copied', 'shared'));

comment on column orders.link_shared_at is
  'When a payment message was last copied or shared from the app; null if never.';
comment on column orders.link_shared_via is
  'How: copied (to the clipboard) or shared (native share sheet).';
