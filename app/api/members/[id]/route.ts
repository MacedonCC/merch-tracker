import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase-server';
import { requireAdmin } from '@/lib/member';
import { findAuthUserId } from '@/lib/auth-admin';

const PERMISSION_FIELDS = ['can_adjust_stock', 'can_change_prices', 'can_change_targets', 'can_undo_handover'] as const;

// Updates a member's role and/or permission flags (the Committee
// table's "Make admin/helper" and per-row Save button).
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Admins only.' }, { status: 403 });

  const body = await request.json().catch(() => null);
  const update: Record<string, boolean | string> = {};

  if (body?.role !== undefined) {
    if (params.id === admin.id && body.role !== 'admin') {
      return NextResponse.json({ error: "You can't change your own role." }, { status: 400 });
    }
    if (body.role !== 'admin' && body.role !== 'helper') {
      return NextResponse.json({ error: 'Role must be admin or helper.' }, { status: 400 });
    }
    update.role = body.role;
  }

  for (const field of PERMISSION_FIELDS) {
    if (body?.[field] !== undefined) update[field] = !!body[field];
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 });
  }

  const db = createAdminSupabase();
  const { data: member, error } = await db
    .from('members')
    .update(update)
    .eq('id', params.id)
    .select('id, email, full_name, role, created_at, can_adjust_stock, can_change_prices, can_change_targets, can_undo_handover')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ member });
}

// Removes a committee member: deletes the `members` row and, if a
// matching auth user exists, deletes that auth user too — so a removed
// member can't still sign in with a stale session or magic link.
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Admins only.' }, { status: 403 });
  if (params.id === admin.id) {
    return NextResponse.json({ error: "You can't remove yourself." }, { status: 400 });
  }

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
