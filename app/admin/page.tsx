import { redirect } from 'next/navigation';
import { createServerSupabase, createAdminSupabase } from '@/lib/supabase-server';
import { resolveViewer } from '@/lib/member';
import Header from '@/components/Header';
import NotOnCommitteeList from '@/components/NotOnCommitteeList';
import AdminPanel, { type MemberRow, type InvitationRow } from '@/components/AdminPanel';
import PaymentMatchPanel from '@/components/PaymentMatchPanel';
import { loadReviewList, type ReviewPair } from '@/lib/payment-link-review';
import { paymentLinkMatchEnabled } from '@/lib/wix-sync-run';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const viewer = await resolveViewer();
  if (!viewer) redirect('/login');
  if (!viewer.member) return <NotOnCommitteeList email={viewer.email} />;
  if (viewer.member.role !== 'admin') redirect('/');

  const supabase = createServerSupabase();
  const [{ data: members }, { data: invitations }] = await Promise.all([
    supabase
      .from('members')
      .select('id, email, full_name, role, created_at, can_adjust_stock, can_change_prices, can_change_targets, can_undo_handover')
      .order('created_at'),
    supabase
      .from('invitations')
      .select('*')
      .eq('status', 'pending')
      .order('invited_at', { ascending: false }),
  ]);

  // Service-role read, safe only because of the role check above:
  // payment_match_dismissals has no RLS policies. A failure here must
  // not take the committee list down with it.
  let pairs: ReviewPair[] = [];
  let pairsError: string | null = null;
  try {
    pairs = await loadReviewList(createAdminSupabase());
  } catch (e) {
    pairsError = e instanceof Error ? e.message : 'Could not load payment-link matches.';
  }

  return (
    <>
      <Header userEmail={viewer.member.email} fullName={viewer.member.full_name} role={viewer.member.role} />
      <div className="shell">
        {pairsError
          ? <div className="note note-bad" style={{ marginBottom: '1rem' }}>Payment-link matches: {pairsError}</div>
          : <PaymentMatchPanel initialPairs={pairs} autoMatching={paymentLinkMatchEnabled()} />}
        <AdminPanel
          initialMembers={(members as MemberRow[]) ?? []}
          initialInvitations={(invitations as InvitationRow[]) ?? []}
          selfId={viewer.member.id}
        />
      </div>
    </>
  );
}
