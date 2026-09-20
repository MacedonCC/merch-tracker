import { NextRequest, NextResponse } from 'next/server';
import { getCurrentMember } from '@/lib/member';
import { pushAvailableToWix, pushEnabled } from '@/lib/wix-push';

// Pushes the tracker's `available` figure into Wix inventory.
//
// Two callers, two auth styles, which is why this route checks both:
//   - the daily run, which arrives with CRON_SECRET and no session
//   - the "Push to Wix now" button on the Stock page, which arrives
//     with an admin's cookie and no secret
// Admin-only for the browser path: this takes sizes off sale in the
// public shop, which is further-reaching than anything a helper can do.
//
// SAFE BY DEFAULT. A GET reports and writes nothing, whatever the
// env flag says. Writing needs a POST *and* WIX_PUSH_ENABLED=true, so
// a preview deployment pointed at the live shop cannot change it by
// being visited.

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

async function authorise(req: NextRequest) {
  if (hasCronSecret(req)) return { ok: true as const, who: 'cron' as const, label: 'cron' };
  const member = await getCurrentMember();
  if (member && member.role === 'admin') {
    return { ok: true as const, who: 'manual' as const, label: member.email };
  }
  return { ok: false as const };
}

// GET = report only. Always safe.
export async function GET(req: NextRequest) {
  const auth = await authorise(req);
  if (!auth.ok) return json({ error: 'Not authorised' }, 401);

  const result = await pushAvailableToWix({
    write: false,
    source: auth.who,
    pushedBy: auth.label,
  });
  return json({ ...result, pushEnabled: pushEnabled(), mode: 'report' });
}

// POST = attempt a real push, still gated on the env flag.
export async function POST(req: NextRequest) {
  const auth = await authorise(req);
  if (!auth.ok) return json({ error: 'Not authorised' }, 401);

  const result = await pushAvailableToWix({
    write: true,
    source: auth.who,
    pushedBy: auth.label,
  });
  return json({ ...result, pushEnabled: pushEnabled(), mode: result.wrote ? 'write' : 'report' });
}
