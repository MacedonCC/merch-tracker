import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase-server';

// Pulls current stock counts out of the Wix inventory and writes them into the
// tracker. Run it whenever you want to reset the tracker's numbers to match Wix.
//
// This overwrites quantities. If you have corrected a count by hand in the
// tracker, running this will replace it with whatever Wix says.

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface WixInventoryVariant {
  variantId?: string;
  inStock?: boolean;
  quantity?: number;
  trackQuantity?: boolean;
}

interface WixInventoryItem {
  productId?: string;
  trackInventory?: boolean;
  variants?: WixInventoryVariant[];
}

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: 'Not authorised' }, { status: 401 });
  }

  if (!process.env.WIX_API_KEY || !process.env.WIX_SITE_ID) {
    return NextResponse.json({ error: 'Wix is not connected yet.' }, { status: 400 });
  }

  const res = await fetch('https://www.wixapis.com/stores/v2/inventoryItems/query', {
    method: 'POST',
    headers: {
      Authorization: process.env.WIX_API_KEY,
      'wix-site-id': process.env.WIX_SITE_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: { paging: { limit: 100 } } }),
  });

  if (!res.ok) {
    const detail = await res.text();
    return NextResponse.json(
      { error: `Wix returned ${res.status}`, detail: detail.slice(0, 400) },
      { status: 502 }
    );
  }

  const data = await res.json();
  const inventory: WixInventoryItem[] = data.inventoryItems ?? [];

  const supabase = createAdminSupabase();

  const { data: stock } = await supabase
    .from('stock_items')
    .select('id, name, size, quantity, wix_product_id, wix_variant_id');

  type Row = {
    id: string; name: string; size: string; quantity: number;
    wix_product_id: string | null; wix_variant_id: string | null;
  };
  const rows = (stock ?? []) as Row[];

  const updated: string[] = [];
  const untracked: string[] = [];
  const noMatch: string[] = [];

  for (const item of inventory) {
    if (!item.productId) continue;

    for (const v of item.variants ?? []) {
      // Find the tracker row for this Wix variant.
      const match =
        rows.find(
          (r) => r.wix_product_id === item.productId && r.wix_variant_id === v.variantId
        ) ??
        rows.find(
          (r) => r.wix_product_id === item.productId && !r.wix_variant_id
        );

      if (!match) {
        noMatch.push(`${item.productId} / ${v.variantId ?? 'default'}`);
        continue;
      }

      // Wix only reports a number when quantity tracking is switched on.
      if (v.trackQuantity !== true || typeof v.quantity !== 'number') {
        untracked.push(`${match.name} / ${match.size}`);
        continue;
      }

      const newQty = Math.max(0, v.quantity);
      const diff = newQty - match.quantity;

      const { error } = await supabase
        .from('stock_items')
        .update({ quantity: newQty, updated_at: new Date().toISOString() })
        .eq('id', match.id);

      if (!error) {
        updated.push(`${match.name} / ${match.size}: ${match.quantity} → ${newQty}`);

        if (diff !== 0) {
          await supabase.from('stock_movements').insert({
            stock_item_id: match.id,
            change: diff,
            reason: 'Imported from Wix inventory',
            created_by: 'wix-inventory-sync',
          });
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    inventoryItemsFound: inventory.length,
    quantitiesUpdated: updated.length,
    updated,
    notTrackedInWix: Array.from(new Set(untracked)),
    couldNotMatch: noMatch.length,
    note:
      untracked.length > 0
        ? 'Some items do not have quantity tracking switched on in Wix, so they were left at their current count. Set those by hand.'
        : 'All matched items updated.',
  });
}
