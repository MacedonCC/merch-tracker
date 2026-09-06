import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase-server';
import { requireAdmin } from '@/lib/member';

// "Add directly" — creates a members row with no invitation email.
// For fixing a role or adopting an account that already exists in
// auth.users (e.g. from before this tracker, or a previous invite).
// The normal path for a brand new person is POST /api/invitations.
export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Admins only.' }, { status: 403 });

  const body = await request.json().catch(() => null);
  const email = String(body?.email ?? '').trim().toLowerCase();
  const fullName = String(body?.full_name ?? '').trim() || null;
  const role = body?.role === 'admin' ? 'admin' : 'helper';
  if (!email) return NextResponse.json({ error: 'Email is required.' }, { status: 400 });

  const db = createAdminSupabase();
  const { data: member, error } = await db
    .from('members')
    .insert({ email, full_name: fullName, role })
    .select('id, email, full_name, role, created_at, can_adjust_stock, can_change_prices, can_change_targets, can_undo_handover')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ member });
}
