import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase-server';
import { buildReport, type OrderRow } from '@/lib/payment-link-match';

// One-off reconciliation of /sell payment-link orders against Wix
// orders that wix-sync has already imported as separate rows. Uses the
// same matcher as wix-sync (lib/payment-link-match.ts).
//
// GET is a dry run and writes nothing: it lists every candidate pair
// with names, dates, order ids and handed-over state, and says which
// would merge automatically and which need confirming. There is no
// apply yet.
//
// CRON_SECRET bearer auth, like the other Wix routes: it is run by
// hand, not from the app.

export const dynamic = 'force-dynamic';

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: 'Not authorised' }, { status: 401 });
  }

  const supabase = createAdminSupabase();
  const cols = 'id, reference, customer_name, customer_email, stock_item_id, quantity, ordered_at, distributed_at, wix_order_id, notes';

  const [manualRes, wixRes, stockRes] = await Promise.all([
    supabase.from('orders').select(cols)
      .eq('source', 'manual').eq('payment_status', 'pending').is('wix_order_id', null),
    supabase.from('orders').select(cols)
      .eq('source', 'wix').eq('payment_status', 'paid').not('stock_item_id', 'is', null),
    supabase.from('stock_items').select('id, name, size'),
  ]);

  const error = manualRes.error ?? wixRes.error ?? stockRes.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const report = buildReport(
    (manualRes.data ?? []) as OrderRow[],
    (wixRes.data ?? []) as OrderRow[],
    (stockRes.data ?? []) as { id: string; name: string; size: string }[],
  );
  return NextResponse.json({ dryRun: true, ...report });
}
