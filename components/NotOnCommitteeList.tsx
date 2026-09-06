'use client';

import { createClient } from '@/lib/supabase-client';

export default function NotOnCommitteeList({ email }: { email: string }) {
  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>Not on the committee list</h1>
        <p>
          You&apos;re signed in as {email}, but that address isn&apos;t on the
          committee list yet. Ask an admin to add you on the Admin page, then
          sign in again.
        </p>
        <button className="btn-solid" style={{ width: '100%' }} onClick={signOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
