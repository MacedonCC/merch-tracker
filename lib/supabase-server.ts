import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createClient as createAdmin } from '@supabase/supabase-js';
import type { CookieOptions } from '@supabase/ssr';

type CookieItem = { name: string; value: string; options?: CookieOptions };

// Next.js patches the global fetch and, by default, may cache a
// response in its Data Cache even when a route is force-dynamic —
// that caching applies to any fetch() call, including the ones
// supabase-js makes internally, not just fetches written directly in
// route/page code. Without this, a Supabase REST response can get
// served stale on a later request (confirmed: a wix-sync run reported
// 86 stock_items when the live table had 88 — exactly the two rows
// added most recently). Passing cache: 'no-store' here forces every
// Supabase request, from every client below, to always hit Supabase
// fresh.
function noStoreFetch(url: RequestInfo | URL, init?: RequestInit) {
  return fetch(url, { ...init, cache: 'no-store' });
}

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
      global: { fetch: noStoreFetch },
    }
  );
}

// Admin client for background jobs (the Wix sync). Server side only.
export function createAdminSupabase() {
  return createAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false },
      global: { fetch: noStoreFetch },
    }
  );
}
