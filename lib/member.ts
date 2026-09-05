import { createServerSupabase } from '@/lib/supabase-server';

export type MemberRole = 'admin' | 'helper';

export interface CurrentMember {
  id: string;
  email: string;
  full_name: string | null;
  role: MemberRole;
  created_at: string;
}

// Looks up the signed-in user's row in `members`. Null if they're
// signed in but not on the committee list.
export async function getCurrentMember(): Promise<CurrentMember | null> {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return null;

  const { data } = await supabase
    .from('members')
    .select('id, email, full_name, role, created_at')
    .ilike('email', user.email)
    .maybeSingle();

  return (data as CurrentMember) ?? null;
}

export async function isAdmin(): Promise<boolean> {
  const member = await getCurrentMember();
  return member?.role === 'admin';
}
