import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase-server';
import { requireAdmin } from '@/lib/member';
import { loadReviewList } from '@/lib/payment-link-review';

// The Admin nav tab's badge: how many pairs on the Admin page's
// "Payment-link matches" card are waiting for a decision (needs
// confirming or near-miss; dismissed pairs are already left out by
// loadReviewList). Read only. Admin only, checked here because this
// uses the service-role client (dismissals have no RLS policies).

export const dynamic = 'force-dynamic';

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Admins only.' }, { status: 403 });

  try {
    const pairs = await loadReviewList(createAdminSupabase());
    const count = pairs.filter((p) => p.kind === 'confirm' || p.kind === 'near-miss').length;
    return NextResponse.json({ count });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Read failed.' }, { status: 500 });
  }
}
