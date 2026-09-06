import { createServerSupabase } from '@/lib/supabase-server';

export type MemberRole = 'admin' | 'helper';

export interface MemberPermissions {
  can_adjust_stock: boolean;
  can_change_prices: boolean;
  can_change_targets: boolean;
  can_undo_handover: boolean;
}

export interface CurrentMember extends MemberPermissions {
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

const MEMBER_COLUMNS =
  'id, email, full_name, role, created_at, can_adjust_stock, can_change_prices, can_change_targets, can_undo_handover';

// Admins have every permission implicitly, whatever the columns say —
// this is the one place that rule is applied, so every screen and API
// route should go through this instead of reading the raw flags.
export function effectivePermissions(member: Pick<CurrentMember, 'role'> & Partial<MemberPermissions>): MemberPermissions {
  if (member.role === 'admin') {
    return { can_adjust_stock: true, can_change_prices: true, can_change_targets: true, can_undo_handover: true };
  }
  return {
    can_adjust_stock: !!member.can_adjust_stock,
    can_change_prices: !!member.can_change_prices,
    can_change_targets: !!member.can_change_targets,
    can_undo_handover: !!member.can_undo_handover,
  };
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
    .select(MEMBER_COLUMNS)
    .ilike('email', user.email)
    .maybeSingle();

  return { email: user.email, member: (data as CurrentMember) ?? null };
}

export async function getCurrentMember(): Promise<CurrentMember | null> {
  const viewer = await resolveViewer();
  return viewer?.member ?? null;
}

// For API routes that use the service-role client (and so bypass RLS):
// verifies the caller is a signed-in admin before doing anything
// privileged. Never trust a route just being unreachable through the UI.
export async function requireAdmin(): Promise<CurrentMember | null> {
  const viewer = await resolveViewer();
  if (!viewer?.member || viewer.member.role !== 'admin') return null;
  return viewer.member;
}
