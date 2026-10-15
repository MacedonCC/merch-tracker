-- Pairs an admin has looked at on the Admin page's "Payment-link
-- matches" card and decided are NOT the same sale (e.g. two different
-- customers buying the same cap in the same week). Without this, a
-- near-miss stays listed for as long as the manual order is open.
--
-- Keyed on the two order rows. Both cascade: once either order is
-- merged, paid or removed the pair can no longer be listed anyway.
--
-- Written and read only through app/api/payment-link-match and the
-- admin page, both of which check role = 'admin' and use the
-- service-role client, so RLS is on with no policies.

create table if not exists payment_match_dismissals (
  manual_order_id uuid not null references orders(id) on delete cascade,
  wix_order_row_id uuid not null references orders(id) on delete cascade,
  dismissed_by text not null,
  dismissed_at timestamptz not null default now(),
  primary key (manual_order_id, wix_order_row_id)
);

alter table payment_match_dismissals enable row level security;
