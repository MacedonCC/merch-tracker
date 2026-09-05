import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createClient as createAdmin } from '@supabase/supabase-js';
import type { CookieOptions } from '@supabase/ssr';

type CookieItem = { name: string; value: string; options?: CookieOptions };

export function createServerSupabase() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (list: CookieItem[]) => {
          try {
            list.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component — safe to ignore.
          }
        },
      },
    }
  );
}

// Admin client for background jobs (the Wix sync). Server side only.
export function createAdminSupabase() {
  return createAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}
