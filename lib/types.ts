export type StockStatus = 'ok' | 'low' | 'out';
export type PaymentStatus = 'pending' | 'paid' | 'refunded';

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

export function money(n: number): string {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n);
}

export function initials(email: string, fullName?: string | null): string {
  const source = fullName?.trim() || email.split('@')[0];
  const parts = source.split(/[.\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}
