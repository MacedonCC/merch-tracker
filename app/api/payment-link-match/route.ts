import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase-server';
import { requireAdmin } from '@/lib/member';
import { buildReport, mergeNote, toPaidWixLine, type OrderRow } from '@/lib/payment-link-match';
import { loadMatchInputs } from '@/lib/payment-link-review';

// Reconciliation of /sell payment-link orders against Wix orders that
// wix-sync has already imported as separate rows. Uses the same
// matcher as wix-sync (lib/payment-link-match.ts).
//
// GET is a dry run and writes nothing: it lists every candidate pair
// with names, dates, order ids and handed-over state, and says which
// would merge automatically and which need confirming. CRON_SECRET
// bearer auth, like the other Wix routes: it is run by hand.
//
// POST is the Admin page's "Payment-link matches" card: approve
// (merge) or dismiss one pair. Admin only, checked here because this
// uses the service-role client.

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

  try {
    const i = await loadMatchInputs(createAdminSupabase());
    return NextResponse.json({ dryRun: true, ...buildReport(i.manualRows, i.wixRows, i.stockRows) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Read failed.' }, { status: 500 });
  }
}

const ORDER_COLUMNS =
  'id, reference, customer_name, customer_email, stock_item_id, quantity, ordered_at, distributed_at, wix_order_id, notes, source, payment_status';

export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Admins only.' }, { status: 403 });

  const body = await req.json().catch(() => null);
  const action = body?.action;
  const manualId = String(body?.manualId ?? '');
  const wixRowId = String(body?.wixRowId ?? '');
  if ((action !== 'approve' && action !== 'dismiss') || !manualId || !wixRowId) {
    return NextResponse.json({ error: 'Expected action, manualId and wixRowId.' }, { status: 400 });
  }

  const db = createAdminSupabase();

  if (action === 'dismiss') {
    const { error } = await db.from('payment_match_dismissals').upsert(
      { manual_order_id: manualId, wix_order_row_id: wixRowId, dismissed_by: admin.email },
      { onConflict: 'manual_order_id,wix_order_row_id', ignoreDuplicates: true },
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  // Approve. Both rows are re-read here rather than trusting the
  // browser; merge_payment_link_order() re-checks everything again
  // under row locks, and is what actually refuses a bad pair.
  const { data: rows, error: readError } = await db.from('orders').select(ORDER_COLUMNS).in('id', [manualId, wixRowId]);
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });

  type Row = OrderRow & { source: string; payment_status: string };
  const manual = (rows as Row[] | null)?.find((r) => r.id === manualId);
  const wix = (rows as Row[] | null)?.find((r) => r.id === wixRowId);
  if (!manual || manual.source !== 'manual') {
    return NextResponse.json({ error: 'That /sell order no longer exists.' }, { status: 400 });
  }
  if (!wix || wix.source !== 'wix' || !wix.wix_order_id) {
    return NextResponse.json({ error: 'That Wix order no longer exists.' }, { status: 400 });
  }

  const { error } = await db.rpc('merge_payment_link_order', {
    p_manual_id: manual.id,
    p_wix_order_id: wix.wix_order_id,
    p_note: mergeNote(toPaidWixLine(wix), manual.customer_email),
    p_wix_row_id: wix.id,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true, merged: manual.reference });
}
