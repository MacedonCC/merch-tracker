import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase-server';
import { resolveViewer } from '@/lib/member';

async function requireAdmin() {
  const viewer = await resolveViewer();
  if (!viewer?.member || viewer.member.role !== 'admin') return null;
  return viewer.member;
}

// Finds the auth.users id for an email. supabase-js's admin API has no
// get-user-by-email call, so this pages through listUsers looking for it.
async function findAuthUserId(db: ReturnType<typeof createAdminSupabase>, email: string) {
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data) return null;
    const match = data.users.find((u) => u.email?.toLowerCase() === target);
    if (match) return match.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

// Removes a committee member: deletes the `members` row and, if a
// matching auth user exists, deletes that auth user too — so a removed
// member can't still sign in with a stale session or magic link.
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Admins only.' }, { status: 403 });

  const db = createAdminSupabase();

  const { data: member, error: fetchError } = await db
    .from('members')
    .select('id, email')
    .eq('id', params.id)
    .maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 400 });
  if (!member) return NextResponse.json({ error: 'Member not found.' }, { status: 404 });

  const { error: deleteError } = await db.from('members').delete().eq('id', member.id);
  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 400 });

  const authUserId = await findAuthUserId(db, member.email);
  if (authUserId) await db.auth.admin.deleteUser(authUserId);

  return NextResponse.json({ ok: true });
}
