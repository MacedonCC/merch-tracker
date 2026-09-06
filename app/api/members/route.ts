import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabase, createAdminSupabase } from '@/lib/supabase-server';
import { resolveViewer } from '@/lib/member';

// Verifies the caller is signed in AND has role 'admin' in `members`.
// Must be checked here, server-side — the admin page hiding itself in the
// UI is not access control.
async function requireAdmin() {
  const viewer = await resolveViewer();
  if (!viewer?.member || viewer.member.role !== 'admin') return null;
  return viewer.member;
}

// Adds a committee member: creates the `members` row and sends a Supabase
// auth invite email so they can sign in. If an auth user already exists
// for that email (e.g. they signed in once before being added, or were
// removed and re-added), the members row is still created — they just
// don't get a fresh invite email, since they can already sign in.
export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Admins only.' }, { status: 403 });

  const body = await request.json().catch(() => null);
  const email = String(body?.email ?? '').trim().toLowerCase();
  const fullName = String(body?.full_name ?? '').trim() || null;
  const role = body?.role === 'admin' ? 'admin' : 'helper';
  if (!email) return NextResponse.json({ error: 'Email is required.' }, { status: 400 });

  const db = createAdminSupabase();

  const { data: member, error: insertError } = await db
    .from('members')
    .insert({ email, full_name: fullName, role })
    .select('id, email, full_name, role, created_at')
    .single();
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 400 });

  const redirectTo = `${request.nextUrl.origin}/auth/callback`;
  const { error: inviteError } = await db.auth.admin.inviteUserByEmail(email, { redirectTo });

  if (!inviteError) {
    return NextResponse.json({ member, invited: true, alreadyRegistered: false });
  }
  if (inviteError.code === 'email_exists' || /already been registered|already exists/i.test(inviteError.message)) {
    return NextResponse.json({ member, invited: false, alreadyRegistered: true });
  }
  return NextResponse.json({ member, invited: false, alreadyRegistered: false, inviteError: inviteError.message });
}
