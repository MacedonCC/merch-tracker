import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase-server';
import { resolveViewer } from '@/lib/member';
import Header from '@/components/Header';
import NotOnCommitteeList from '@/components/NotOnCommitteeList';
import AdminPanel, { type MemberRow, type InvitationRow } from '@/components/AdminPanel';

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

  return (
    <>
      <Header userEmail={viewer.member.email} fullName={viewer.member.full_name} role={viewer.member.role} />
      <div className="shell">
        <AdminPanel
          initialMembers={(members as MemberRow[]) ?? []}
          initialInvitations={(invitations as InvitationRow[]) ?? []}
          selfId={viewer.member.id}
        />
      </div>
    </>
  );
}
