import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase-server';
import { requireAdmin } from '@/lib/member';

const PERMISSION_FIELDS = ['can_adjust_stock', 'can_change_prices', 'can_change_targets', 'can_undo_handover'] as const;

// The normal way to add a committee member: records an invitation (role
// + permissions the person will get) and emails them a sign-in link via
// Supabase auth. Accepting the invite — clicking the link — is handled
// in app/auth/callback/route.ts, which is what actually creates their
// `members` row; this route never creates one itself, so re-inviting an
// email that hasn't accepted yet is safe.
export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Admins only.' }, { status: 403 });

  const body = await request.json().catch(() => null);
  const email = String(body?.email ?? '').trim().toLowerCase();
  const fullName = String(body?.full_name ?? '').trim() || null;
  const role = body?.role === 'admin' ? 'admin' : 'helper';
  if (!email) return NextResponse.json({ error: 'Email is required.' }, { status: 400 });

  const db = createAdminSupabase();

  const permissions = Object.fromEntries(
    PERMISSION_FIELDS.map((f) => [f, !!body?.[f]])
  );

  const { data: invitation, error: insertError } = await db
    .from('invitations')
    .insert({
      email,
      role,
      ...permissions,
      invited_by: admin.email,
      invited_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'pending',
    })
    .select('*')
    .single();
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 400 });

  const redirectTo = `${request.nextUrl.origin}/auth/callback`;
  // `invitations` has no full_name column (see migration-007) — it rides
  // along in the auth user's metadata instead, and app/auth/callback
  // reads it back from there when it creates the members row.
  const { error: inviteError } = await db.auth.admin.inviteUserByEmail(email, {
    redirectTo,
    data: fullName ? { full_name: fullName } : undefined,
  });

  if (!inviteError) {
    return NextResponse.json({ invitation, invited: true, alreadyRegistered: false });
  }
  if (inviteError.code === 'email_exists' || /already been registered|already exists/i.test(inviteError.message)) {
    return NextResponse.json({ invitation, invited: false, alreadyRegistered: true });
  }
  return NextResponse.json({ invitation, invited: false, alreadyRegistered: false, inviteError: inviteError.message });
}
