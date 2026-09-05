import { createServerSupabase } from '@/lib/supabase-server';

export type MemberRole = 'admin' | 'helper';

export interface CurrentMember {
  id: string;
  email: string;
  full_name: string | null;
  role: MemberRole;
  created_at: string;
}

export interface Viewer {
  email: string;
  member: CurrentMember | null;
}

// Resolves the signed-in user's email and their row in `members`
// (member is null if they're signed in but not on the committee list).
// Returns null only if there's no signed-in user at all.
export async function resolveViewer(): Promise<Viewer | null> {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return null;

  const { data } = await supabase
    .from('members')
    .select('id, email, full_name, role, created_at')
    .ilike('email', user.email)
    .maybeSingle();

  return { email: user.email, member: (data as CurrentMember) ?? null };
}

export async function getCurrentMember(): Promise<CurrentMember | null> {
  const viewer = await resolveViewer();
  return viewer?.member ?? null;
}
