import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase-server';
import { resolveViewer } from '@/lib/member';
import Header from '@/components/Header';
import NotOnCommitteeList from '@/components/NotOnCommitteeList';
import AdminPanel, { type MemberRow } from '@/components/AdminPanel';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const viewer = await resolveViewer();
  if (!viewer) redirect('/login');
  if (!viewer.member) return <NotOnCommitteeList email={viewer.email} />;
  if (viewer.member.role !== 'admin') redirect('/');

  const supabase = createServerSupabase();
  const { data: members } = await supabase
    .from('members')
    .select('id, email, full_name, role, created_at')
    .order('created_at');

  return (
    <>
      <Header userEmail={viewer.member.email} fullName={viewer.member.full_name} role={viewer.member.role} />
      <div className="shell">
        <AdminPanel initialMembers={(members as MemberRow[]) ?? []} selfEmail={viewer.member.email} />
      </div>
    </>
  );
}
