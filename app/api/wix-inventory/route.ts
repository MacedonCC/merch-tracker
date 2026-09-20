import { NextResponse } from 'next/server';

// RETIRED — this route used to overwrite stock_items.quantity with
// whatever Wix reported. It now answers 410 Gone and writes nothing.
//
// Two reasons it had to go:
//
// 1. The tracker is the source of truth for stock. Counts come from a
//    physical stocktake and from handovers recorded through /sell and
//    the Orders page, each of which logs a stock_movements row. Wix
//    knows what is for sale, not what is in the cupboard, so importing
//    its numbers would silently overwrite a real count with a guess.
//
// 2. Wix inventory tracking is off for almost the whole catalogue. The
//    products query reports "stock": { "trackQuantity": false } on
//    product after product, and this route treated an untracked product
//    as "leave alone" but a tracked one as authoritative. Playing Cap
//    (one size fits all) is the one product with trackQuantity: true,
//    and Wix says 15 where the tracker says 16 — so the single line it
//    could act on is the single line where the two already disagree.
//
// It was already failing in practice: check_stock_item_update rejects a
// quantity write from a caller with no signed-in member, and this route
// uses the service-role client. Verified against the live database —
// the update raises "Not authorised to update stock items." So the
// route has been erroring rather than corrupting anything. 410 makes
// that deliberate and explains itself, instead of leaving a loaded
// route that would start working again the moment someone widened the
// trigger's exemption.
//
// To correct a count, use Adjust on the Stock page (needs
// can_adjust_stock), which records the change in stock_movements.

export const dynamic = 'force-dynamic';

const GONE = {
  error: 'This route has been retired.',
  reason:
    'The tracker is the source of truth for stock levels, and Wix inventory ' +
    'tracking is switched off for almost every product. Importing Wix counts ' +
    'would overwrite real stocktake numbers with guesses.',
  instead:
    'Correct a count with Adjust on the Stock page, which logs the change to ' +
    'stock_movements. Order history still syncs automatically via /api/wix-sync.',
};

export async function GET() {
  return NextResponse.json(GONE, { status: 410 });
}

export async function POST() {
  return NextResponse.json(GONE, { status: 410 });
}
