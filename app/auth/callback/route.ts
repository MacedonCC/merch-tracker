import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabase, createAdminSupabase } from '@/lib/supabase-server';

// If the person signing in was invited (a pending, unexpired row in
// `invitations` matching their email), turn that invitation into their
// `members` row now. RLS only lets admins insert into `members`, so this
// runs with the service-role client — safe because it only ever acts on
// an invitation an admin already created.
async function acceptInvitationIfAny(email: string, fullName: string | null) {
  const admin = createAdminSupabase();

  const { data: invitation } = await admin
    .from('invitations')
    .select('*')
    .ilike('email', email)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('invited_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!invitation) return;

  const { data: existing } = await admin
    .from('members')
    .select('id')
    .ilike('email', email)
    .maybeSingle();

  if (!existing) {
    await admin.from('members').insert({
      email: invitation.email,
      full_name: fullName,
      role: invitation.role,
      can_adjust_stock: invitation.can_adjust_stock,
      can_change_prices: invitation.can_change_prices,
      can_change_targets: invitation.can_change_targets,
      can_undo_handover: invitation.can_undo_handover,
    });
  }

  await admin.from('invitations').update({ status: 'accepted' }).eq('id', invitation.id);
}

// Handles the magic link click and starts the session.
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const origin = request.nextUrl.origin;

  if (code) {
    const supabase = createServerSupabase();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      if (data.user?.email) {
        const fullName = (data.user.user_metadata?.full_name as string | undefined)?.trim() || null;
        await acceptInvitationIfAny(data.user.email, fullName);
      }
      return NextResponse.redirect(origin);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=link-expired`);
}
