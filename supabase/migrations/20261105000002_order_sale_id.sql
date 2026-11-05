-- Links the order rows written by one /sell checkout. A sale of several
-- items is still one orders row per item, exactly as before, so stock,
-- handovers, the payment-link matcher and wix-sync see nothing new. This
-- column only lets the payment email, "Resend payment link" and "Copy
-- payment message" gather every unpaid item in the same sale into one
-- message.
--
-- Null on every row written before this, and on anything not from /sell
-- (Wix imports, Orders "Add order"); those behave as single-item sales.
--
-- No trigger change needed, for the same reason as email_sent_at
-- (migration 20261008000001): check_order_update() only gates clearing
-- distributed_at, so any committee member can write this.
alter table orders
  add column if not exists sale_id uuid;

create index if not exists orders_sale_id_idx on orders (sale_id) where sale_id is not null;

comment on column orders.sale_id is
  'Shared by the rows of one /sell checkout; null for single orders and anything not from /sell.';
