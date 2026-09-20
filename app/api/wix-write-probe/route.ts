import { NextRequest, NextResponse } from 'next/server';

// THROWAWAY DIAGNOSTIC — delete once the question is answered.
//
// Establishes one fact: can the WIX_API_KEY write inventory? Everything
// in the "block online sales at zero" plan depends on it, and a Wix API
// key's scopes are not readable from the API, so the only way to find
// out is to attempt a write and look at the status code.
//
// IT CANNOT CHANGE ANYTHING. The write is built from the values it just
// read back from Wix in the same request: same trackQuantity, same
// quantity per variant. A 200 proves permission; the shop is untouched
// either way. There is no code path here that sends a number the read
// did not supply.
//
// Read-only by default; the write attempt needs ?write=1.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface WixVariantStock {
  variantId?: string;
  inStock?: boolean;
  quantity?: number;
}

interface WixInventoryItem {
  id?: string;
  productId?: string;
  trackQuantity?: boolean;
  variants?: WixVariantStock[];
}

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function wix(path: string, method: string, body?: unknown) {
  const res = await fetch(`https://www.wixapis.com${path}`, {
    method,
    headers: {
      Authorization: process.env.WIX_API_KEY as string,
      'wix-site-id': process.env.WIX_SITE_ID as string,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 600); }
  return { status: res.status, ok: res.ok, body: parsed };
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) return json({ error: 'Not authorised' }, 401);
  if (!process.env.WIX_API_KEY || !process.env.WIX_SITE_ID) {
    return json({ error: 'Wix is not connected.' }, 400);
  }

  const wantedName = req.nextUrl.searchParams.get('product') ?? 'Social Hat';
  const doWrite = req.nextUrl.searchParams.get('write') === '1';

  // 1. Find the product by name.
  const products = await wix('/stores/v1/products/query', 'POST', {
    query: { paging: { limit: 100 } },
  });
  if (!products.ok) {
    return json({ step: 'read products', readable: false, ...products });
  }
  const list = ((products.body as { products?: Array<{ id: string; name?: string }> }).products) ?? [];
  const product = list.find((p) => (p.name ?? '').toLowerCase() === wantedName.toLowerCase());
  if (!product) {
    return json({
      error: `No Wix product named "${wantedName}".`,
      available: list.map((p) => p.name),
    }, 404);
  }

  // 2. Read its inventory item.
  const inv = await wix('/stores/v2/inventoryItems/query', 'POST', {
    query: { filter: JSON.stringify({ productId: product.id }), paging: { limit: 10 } },
  });
  if (!inv.ok) {
    return json({
      product: product.name,
      canReadProducts: true,
      canReadInventory: false,
      readInventoryResponse: inv,
      verdict: 'The key can read products but not inventory.',
    });
  }

  const items = ((inv.body as { inventoryItems?: WixInventoryItem[] }).inventoryItems) ?? [];
  const item = items[0];
  if (!item?.id) {
    return json({
      product: product.name,
      canReadProducts: true,
      canReadInventory: true,
      verdict: 'No inventory item returned for this product; nothing to write to.',
      raw: inv.body,
    });
  }

  const before = {
    inventoryItemId: item.id,
    trackQuantity: item.trackQuantity,
    variants: (item.variants ?? []).map((v) => ({
      variantId: v.variantId,
      quantity: v.quantity,
      inStock: v.inStock,
    })),
  };

  if (!doWrite) {
    return json({
      product: product.name,
      productId: product.id,
      canReadProducts: true,
      canReadInventory: true,
      before,
      note: 'Read-only. Add &write=1 to attempt writing these exact values back.',
    });
  }

  // 3. Write back EXACTLY what was just read. Nothing else is sendable:
  //    every value below comes from `item`, not from the request.
  const payload = {
    inventoryItem: {
      trackQuantity: item.trackQuantity,
      ...(item.variants && item.variants.length > 0
        ? {
            variants: item.variants.map((v) => ({
              variantId: v.variantId,
              ...(typeof v.quantity === 'number'
                ? { quantity: v.quantity }
                : { inStock: v.inStock }),
            })),
          }
        : {}),
    },
  };

  const write = await wix(`/stores/v2/inventoryItems/${item.id}`, 'PATCH', payload);

  // 4. Read back, to show the value really is unchanged.
  const after = await wix('/stores/v2/inventoryItems/query', 'POST', {
    query: { filter: JSON.stringify({ productId: product.id }), paging: { limit: 10 } },
  });
  const afterItem = ((after.body as { inventoryItems?: WixInventoryItem[] }).inventoryItems ?? [])[0];

  return json({
    product: product.name,
    productId: product.id,
    canReadProducts: true,
    canReadInventory: true,
    canWriteInventory: write.ok,
    writeStatus: write.status,
    writeResponse: write.body,
    sentPayload: payload,
    before,
    after: afterItem
      ? {
          trackQuantity: afterItem.trackQuantity,
          variants: (afterItem.variants ?? []).map((v) => ({
            variantId: v.variantId,
            quantity: v.quantity,
            inStock: v.inStock,
          })),
        }
      : null,
    verdict: write.ok
      ? 'The key CAN write inventory. Values were written back unchanged.'
      : `The key CANNOT write inventory (HTTP ${write.status}). Nothing changed.`,
  });
}
