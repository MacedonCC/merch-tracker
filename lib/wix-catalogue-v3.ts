// Read-only access to the Wix Stores Catalog V3 API.
//
// Wix moved the store from Catalog V1 to V3 on or after 6 Oct 2026, and
// the V1/V2 endpoints now answer 501 "not supported for sites using
// Catalog V3". V3 splits what V1 returned in one call across three:
//
//   products   POST /stores/v3/products/query        no variants at all
//   variants   POST /stores/v3/products/query-variants   one row each
//   inventory  POST /stores/v3/inventory-items/query     one row per
//                                                        variant per location
//
// Nothing in this file writes to Wix. The write side (lib/wix-push.ts)
// has not been ported and WIX_PUSH_ENABLED stays off until it is.
//
// The V3 docs say variant ids are "not guaranteed unique across
// products", so a variant is only ever identified by productId +
// variantId together. Whether Wix kept the V1 variant ids through the
// conversion is NOT stated anywhere in its docs; wix-import's
// staleVariantIds is the test.

const WIX_API = 'https://www.wixapis.com';
const PAGE_CAP = 50; // runaway guard, not an expected limit

export class WixV3Error extends Error {
  constructor(public status: number, public detail: string, public where: string) {
    super(`Wix returned ${status} for ${where}`);
  }
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${WIX_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: process.env.WIX_API_KEY as string,
      'wix-site-id': process.env.WIX_SITE_ID as string,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) throw new WixV3Error(res.status, (await res.text()).slice(0, 400), path);
  return (await res.json()) as Record<string, unknown>;
}

/** Follows cursors until Wix says there is no next page. After the first
 *  request Wix wants the cursor alone, with no filter or sort. */
async function pagedQuery<T>(
  path: string,
  key: string,
  limit: number,
  extra: Record<string, unknown> = {},
  filter?: Record<string, unknown>
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < PAGE_CAP; page++) {
    const query = cursor
      ? { cursorPaging: { limit, cursor } }
      : { cursorPaging: { limit }, ...(filter ? { filter } : {}) };
    const data = await post(path, { ...extra, query });
    out.push(...(((data[key] as T[] | undefined) ?? [])));
    const meta = data.pagingMetadata as
      | { hasNext?: boolean; cursors?: { next?: string } }
      | undefined;
    cursor = meta?.cursors?.next;
    if (!cursor || meta?.hasNext === false) break;
  }
  return out;
}

// Raw shapes are deliberately loose: this was written from the docs
// before any real response had been seen. ?raw=1 on wix-import shows
// the true shape, and these should be tightened once it has been read.
export type RawProduct = Record<string, any>;
export type RawVariant = Record<string, any>;
export type RawInventoryItem = Record<string, any>;

export interface CatVariant {
  id: string;
  /** Option name -> chosen value, e.g. { Size: 'XL' }. */
  choices: Array<{ option: string; choice: string }>;
  price: number | null;
}

export interface CatProduct {
  id: string;
  name: string;
  variants: CatVariant[];
}

export interface CatalogueV3 {
  products: CatProduct[];
  rawProducts: RawProduct[];
  rawVariants: RawVariant[];
  rawInventory: RawInventoryItem[];
  /** Null when the inventory read worked. Inventory is commentary for
   *  the import, so a failure here is reported rather than thrown. */
  inventoryError: string | null;
}

export async function fetchProductsV3(fields: string[] = ['URL', 'THUMBNAIL', 'MEDIA_ITEMS_INFO']) {
  return pagedQuery<RawProduct>('/stores/v3/products/query', 'products', 100, { fields });
}

export async function fetchVariantsV3() {
  return pagedQuery<RawVariant>('/stores/v3/products/query-variants', 'variants', 1000, { fields: [] });
}

export async function fetchInventoryV3() {
  return pagedQuery<RawInventoryItem>('/stores/v3/inventory-items/query', 'inventoryItems', 1000);
}

function toNumber(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Reads products, variants and inventory and joins variants onto their
 *  product. A product or variant read that fails throws (the import has
 *  nothing to work with); the inventory read does not. */
export async function loadCatalogueV3(): Promise<CatalogueV3> {
  const [rawProducts, rawVariants] = await Promise.all([fetchProductsV3(), fetchVariantsV3()]);

  let rawInventory: RawInventoryItem[] = [];
  let inventoryError: string | null = null;
  try {
    rawInventory = await fetchInventoryV3();
  } catch (e) {
    inventoryError = e instanceof WixV3Error ? `Wix inventory returned ${e.status}` : 'Wix inventory read failed';
  }

  const byProduct = new Map<string, CatVariant[]>();
  for (const v of rawVariants) {
    const productId: string | undefined = v.productData?.productId;
    const id: string | undefined = v.variantId;
    if (!productId || !id) continue;
    const list = byProduct.get(productId) ?? [];
    list.push({
      id,
      choices: ((v.optionChoices ?? []) as RawVariant[])
        .map((c) => ({
          option: String(c.optionChoiceNames?.optionName ?? ''),
          choice: String(c.optionChoiceNames?.choiceName ?? ''),
        }))
        .filter((c) => c.choice),
      price: toNumber(v.price?.actualPrice?.amount),
    });
    byProduct.set(productId, list);
  }

  const products: CatProduct[] = rawProducts
    .filter((p) => typeof p.id === 'string')
    .map((p) => ({
      id: p.id as string,
      name: String(p.name ?? ''),
      variants: byProduct.get(p.id) ?? [],
    }));

  return { products, rawProducts, rawVariants, rawInventory, inventoryError };
}
