// Next.js patches the global fetch and, by default, may cache a response
// in its Data Cache even for a request made from Middleware or a
// force-dynamic route — that caching applies to any fetch() call,
// including the ones supabase-js makes internally, not just fetches
// written directly in route/page code. Without this, a stale response
// can get served on a later request with different data or auth state.
//
// Two confirmed cases this fixed:
// - A wix-sync run reported 86 stock_items when the live table had 88 —
//   exactly the two rows added most recently.
// - Middleware's getUser() call didn't have this, so a cached "no
//   session" response from before sign-in could still be returned right
//   after a successful sign-in, bouncing a freshly authenticated user
//   straight back to /login.
//
// Passing cache: 'no-store' forces every request through this fetch to
// always hit Supabase fresh.
export function noStoreFetch(url: RequestInfo | URL, init?: RequestInit) {
  return fetch(url, { ...init, cache: 'no-store' });
}
