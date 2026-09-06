import type { createAdminSupabase } from '@/lib/supabase-server';

// Finds the auth.users id for an email. supabase-js's admin API has no
// get-user-by-email call, so this pages through listUsers looking for it.
export async function findAuthUserId(db: ReturnType<typeof createAdminSupabase>, email: string) {
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
