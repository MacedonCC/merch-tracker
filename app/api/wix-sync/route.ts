import { NextRequest, NextResponse } from 'next/server';
import { runWixSync } from '@/lib/wix-sync-run';
import { pushAvailableToWix, pushEnabled } from '@/lib/wix-push';

// The daily cron entry point (vercel.json, 09:00 UTC). It does two
// things in a fixed order: import the day's paid Wix orders, then push
// the tracker's availability back to the shop.
//
// THAT ORDER IS THE WHOLE POINT and is why the push has no schedule of
// its own. Between a Wix sale and this sync importing it, `committed`
// is stale-low and so `available` is stale-high; pushing first would
// raise Wix's count and re-offer something already sold. Any other
// caller that pushes must import first too — app/api/wix-push's POST
// does exactly this, so the "Push to Wix now" button mid-day behaves
// like the evening cron.
//
// The import itself lives in lib/wix-sync-run.ts, shared with that
// route. All the reasoning about order inserts, the stock triggers and
// the 3-calls-regardless-of-size shape is in that file's header.

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization');
  return header === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: 'Not authorised' }, { status: 401 });
  }

  const limitParam = Number(req.nextUrl.searchParams.get('limit'));
  const sync = await runWixSync({ limit: limitParam });

  if (!sync.ok) {
    return NextResponse.json({ error: sync.error }, { status: sync.status });
  }

  // Push AFTER the import, for the reason at the top of this file.
  // Does nothing unless WIX_PUSH_ENABLED is true.
  let push: unknown = { skipped: 'WIX_PUSH_ENABLED is not true' };
  if (pushEnabled()) {
    try {
      const result = await pushAvailableToWix({ write: true, source: 'cron', pushedBy: 'wix-sync' });
      push = {
        wrote: result.wrote,
        reason: result.reason,
        ...result.counts,
        failures: result.failures,
      };
    } catch (e) {
      // A failed push must not fail the sync: the orders are already
      // imported and re-running the sync to retry a push would be the
      // wrong shape of fix.
      push = { error: e instanceof Error ? e.message : 'Push failed.' };
    }
  }

  return NextResponse.json({
    ok: true,
    wixPush: push,
    totalFetched: sync.totalFetched,
    imported: sync.imported,
    fulfilled: sync.fulfilled,
    awaitingHandover: sync.awaitingHandover,
    unmatched: sync.unmatched,
    noSizeRecorded: sync.noSizeRecorded,
    message: sync.message,
    ranAt: new Date().toISOString(),
  });
}
