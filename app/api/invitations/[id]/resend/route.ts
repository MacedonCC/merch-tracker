import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase-server';
import { requireAdmin } from '@/lib/member';

// Re-sends the invite email and resets the 7-day expiry. Only makes
// sense for a pending invitation — a revoked or already-accepted one
// can't be resent.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Admins only.' }, { status: 403 });

  const db = createAdminSupabase();

  const { data: invitation, error: fetchError } = await db
    .from('invitations')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 400 });
  if (!invitation) return NextResponse.json({ error: 'Invitation not found.' }, { status: 404 });
  if (invitation.status !== 'pending') {
    return NextResponse.json({ error: 'Only a pending invitation can be re-sent.' }, { status: 400 });
  }

  const redirectTo = `${request.nextUrl.origin}/auth/callback`;
  const { error: inviteError } = await db.auth.admin.inviteUserByEmail(invitation.email, { redirectTo });

  const alreadyRegistered =
    !!inviteError &&
    (inviteError.code === 'email_exists' || /already been registered|already exists/i.test(inviteError.message));

  if (inviteError && !alreadyRegistered) {
    return NextResponse.json({ error: inviteError.message }, { status: 400 });
  }

  const { data: updated, error: updateError } = await db
    .from('invitations')
    .update({
      invited_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .eq('id', invitation.id)
    .select('*')
    .single();
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 400 });

  return NextResponse.json({ invitation: updated, alreadyRegistered });
}
