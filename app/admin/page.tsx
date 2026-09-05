import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase-server';
import { getCurrentMember } from '@/lib/member';
import AdminPanel, { type MemberRow } from '@/components/AdminPanel';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const me = await getCurrentMember();
  if (!me) redirect('/login');
  if (me.role !== 'admin') redirect('/');

  const supabase = createServerSupabase();
  const { data: members } = await supabase
    .from('members')
    .select('id, email, full_name, role, created_at')
    .order('created_at');

  return <AdminPanel initialMembers={(members as MemberRow[]) ?? []} selfEmail={me.email} />;
}
