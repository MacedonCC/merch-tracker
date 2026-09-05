import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase-server';
import Tracker from '@/components/Tracker';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  // Confirm this signed-in email is actually on the committee list.
  const { data: member } = await supabase
    .from('members')
    .select('email, role, full_name')
    .ilike('email', user.email ?? '')
    .maybeSingle();

  if (!member) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <h1>Not on the committee list</h1>
          <p>
            {user.email} isn&apos;t authorised for this tracker. Ask an admin to add
            your email in Supabase, then sign in again.
          </p>
          <form action="/login"><button style={{ width: '100%' }}>Back to sign in</button></form>
        </div>
      </div>
    );
  }

  return (
    <Tracker
      userEmail={user.email ?? ''}
      fullName={member.full_name}
      role={member.role === 'admin' ? 'admin' : 'helper'}
    />
  );
}
