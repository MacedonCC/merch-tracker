-- Records the outcome of the last payment-link email for an order, so a
-- failed send is visible on the Orders row and can be resent.
--
-- No trigger change needed: check_order_update() only gates clearing
-- distributed_at (and substitutions), and the route writes these columns
-- as the signed-in member through the cookie-bound client, so it passes.
alter table orders
  add column if not exists email_sent_at timestamptz,
  add column if not exists email_error text;

comment on column orders.email_sent_at is
  'When the payment-link email last sent successfully; null if never.';
comment on column orders.email_error is
  'Reason the last payment-link send failed; null after a success.';
