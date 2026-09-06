import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase-server';
import { requireAdmin } from '@/lib/member';
import { findAuthUserId } from '@/lib/auth-admin';

// Marks an invitation revoked so it can no longer be accepted. If the
// invite email created an auth user that never signed in (and still
// isn't a member — otherwise this is a no-op safety check), that
// leftover auth user is deleted too, so the link truly stops working.
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

  const { data: updated, error: updateError } = await db
    .from('invitations')
    .update({ status: 'revoked' })
    .eq('id', invitation.id)
    .select('*')
    .single();
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 400 });

  const { data: existingMember } = await db
    .from('members')
    .select('id')
    .ilike('email', invitation.email)
    .maybeSingle();

  if (!existingMember) {
    const authUserId = await findAuthUserId(db, invitation.email);
    if (authUserId) await db.auth.admin.deleteUser(authUserId);
  }

  return NextResponse.json({ invitation: updated });
}
