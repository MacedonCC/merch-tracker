import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { CookieOptions } from '@supabase/ssr';
import { noStoreFetch } from '@/lib/no-store-fetch';

type CookieItem = { name: string; value: string; options?: CookieOptions };

// Every page except the login screen requires a signed-in committee member.
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list: CookieItem[]) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
      // See lib/no-store-fetch.ts — without this, getUser() below can
      // return a cached "no session" result even right after a
      // successful sign-in, which would send an authenticated user
      // straight back to /login before their own page ever runs.
      global: { fetch: noStoreFetch },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();

  // getUser() above refreshes an expired access token, and Supabase
  // ROTATES refresh tokens: the old one is revoked the instant it is
  // used. When that happens, setAll() has written the new auth cookies
  // onto `response` and nowhere else. A redirect built with a bare
  // NextResponse.redirect() therefore throws the new tokens away while
  // the old ones are already dead, so the browser is left holding a
  // revoked token and gets signed out on its very next request — the
  // user sees "logged out again" and goes hunting for a magic link.
  // Every redirect out of this middleware must carry those cookies.
  function redirectTo(pathname: string) {
    const url = request.nextUrl.clone();
    url.pathname = pathname;
    const redirect = NextResponse.redirect(url);
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
    return redirect;
  }

  const path = request.nextUrl.pathname;
  const isPublic = path.startsWith('/login') || path.startsWith('/auth');

  if (!user && !isPublic) return redirectTo('/login');
  if (user && path.startsWith('/login')) return redirectTo('/');

  return response;
}

// Excludes public static assets (images, icons, fonts) as well as the
// Next.js internals and the Wix cron route. This isn't just tidiness:
// the club logo on the login page renders via next/image, and Vercel's
// Image Optimization fetches a "local" /public asset like /mcc-logo.jpg
// with an HTTP request back to this same deployment — a request that,
// unlike the browser's own page navigation, carries no session cookie.
// Before this exclusion, that request hit the "no user -> redirect to
// /login" rule above and got a 307 instead of the image, so the
// optimizer had nothing to transform and the <img> came back broken —
// only ever visible on /login itself, since that's the one page an
// unauthenticated visitor (and so an uncookied asset fetch) ever loads.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/wix-sync|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
