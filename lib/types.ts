export type StockStatus = 'ok' | 'low' | 'out';
export type PaymentStatus = 'pending' | 'paid' | 'refunded';
export type PaymentMethod = 'cash' | 'online' | 'unknown';

export interface StockItem {
  id: string;
  name: string;
  category: string;
  size: string;
  price: number;
  quantity: number;
  low_stock_alert: number;
  wix_product_id: string | null;
  wix_variant_id: string | null;
  image_url: string | null;
  wix_product_url: string | null;
  updated_at: string;
}

export interface Order {
  id: string;
  reference: string;
  customer_name: string;
  customer_email: string | null;
  stock_item_id: string | null;
  quantity: number;
  unit_price: number;
  payment_status: PaymentStatus;
  payment_method: PaymentMethod;
  distributed_at: string | null;
  source: 'manual' | 'wix';
  wix_order_id: string | null;
  notes: string | null;
  ordered_at: string;
  stock_items?: Pick<StockItem, 'name' | 'size'> | null;
}

export function stockStatus(item: Pick<StockItem, 'quantity' | 'low_stock_alert'>): StockStatus {
  if (item.quantity === 0) return 'out';
  if (item.quantity <= item.low_stock_alert) return 'low';
  return 'ok';
}

// Canonical size order, matching the vocabulary standardised in
// migration 20260920000001 (juniors, then adult small to large, then
// one-size items). sizeRank() falls back to the end of the list rather
// than dropping anything unrecognised, so a new size still renders.
export const SIZE_ORDER = [
  'JNR8', 'JNR10', 'JNR12', 'JNR14', 'JNR16',
  'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL',
  'One size',
];

export function sizeRank(size: string): number {
  const i = SIZE_ORDER.indexOf(size.trim());
  return i === -1 ? SIZE_ORDER.length : i;
}

// Customer names arrive with stray whitespace — Wix stores first and
// last names with their own trailing spaces, and joining them yields
// "Ollie  Neilsen"; hand-typed names pick up a trailing space from a
// phone keyboard. Untidy names split one person into several entries in
// the /sell type-ahead and break customer grouping on Orders, so every
// write path normalises through here rather than each doing its own
// trim. \s covers tabs and newlines as well as spaces.
export function tidyName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

// Wix spells sizes inconsistently across products - "Small" on some,
// "S" on others - and migration 20260920000001 standardised the tracker
// on the short forms, so the two sides can disagree for any product Wix
// spells out. Both wix-sync (matching an order line to a stock row) and
// wix-import (matching a catalogue entry to a stock row) normalise
// through here before comparing. It lives in one place because the two
// MUST agree: a size that imports under one spelling and syncs under
// another silently creates a duplicate line that never receives orders.
const SIZE_ALIASES: Record<string, string> = {
  small: 's', medium: 'm', large: 'l',
  'one size fits all': 'one size',
};

export function normaliseSize(size: string): string {
  const key = tidyName(size).toLowerCase();
  return SIZE_ALIASES[key] ?? key;
}

// The key both Wix matchers use to line a catalogue entry up with a
// stock_items row when there is no variant id to go on.
export function nameSizeKey(name: string, size: string): string {
  return `${tidyName(name).toLowerCase()}::${normaliseSize(size)}`;
}

export function money(n: number): string {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n);
}

export function initials(email: string, fullName?: string | null): string {
  const source = fullName?.trim() || email.split('@')[0];
  const parts = source.split(/[.\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}
