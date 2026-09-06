'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-client';

interface Counts {
  onHand: number;
  readyToHandOver: number;
  linesToReorder: number;
}

const EMPTY: Counts = { onHand: 0, readyToHandOver: 0, linesToReorder: 0 };

function TileEmoji({ children }: { children: string }) {
  return (
    <span
      role="img"
      aria-hidden="true"
      style={{ fontSize: '72px', lineHeight: 1, display: 'inline-block' }}
    >
      {children}
    </span>
  );
}

export default function HomeTiles() {
  const [counts, setCounts] = useState<Counts>(EMPTY);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const [{ data: stock }, { data: orders }] = await Promise.all([
        supabase.from('stock_overview').select('id, on_hand, suggested_order'),
        supabase.from('orders').select('quantity, payment_status, distributed_at, stock_item_id'),
      ]);

      const onHandById = new Map((stock ?? []).map((s) => [s.id, s.on_hand as number]));

      const readyToHandOver = (orders ?? []).filter((o) => {
        if (o.payment_status !== 'paid' || o.distributed_at) return false;
        const onHand = o.stock_item_id ? onHandById.get(o.stock_item_id) : undefined;
        return onHand !== undefined && onHand >= o.quantity;
      }).length;

      setCounts({
        onHand: (stock ?? []).reduce((n, s) => n + (s.on_hand as number), 0),
        readyToHandOver,
        linesToReorder: (stock ?? []).filter((s) => (s.suggested_order as number) > 0).length,
      });
      setLoading(false);
    })();
  }, []);

  const tiles = [
    {
      href: '/stock',
      category: 'Inventory',
      title: 'Stock',
      icon: <TileEmoji>👕</TileEmoji>,
      description: 'Inventory levels for every item and size.',
      value: counts.onHand,
      label: 'garments on hand',
    },
    {
      href: '/restock',
      category: 'Purchasing',
      title: 'Restock',
      icon: <TileEmoji>📋</TileEmoji>,
      description: 'What to order to hit target levels.',
      value: counts.linesToReorder,
      label: 'lines to reorder',
    },
    {
      href: '/orders',
      category: 'Fulfilment',
      title: 'Orders',
      icon: <TileEmoji>🧾</TileEmoji>,
      description: 'Paid orders ready to give out.',
      value: counts.readyToHandOver,
      label: 'ready to hand over',
    },
  ];

  return (
    <div className="tile-grid">
      {tiles.map((t) => (
        <Link key={t.href} href={t.href} className="tile">
          <span className="tile-category">{t.category}</span>
          <h3>{t.title}</h3>
          <div className="tile-icon">{t.icon}</div>
          <p>{t.description}</p>
          <div className="tile-footer">
            <span className="tile-label">{t.label}</span>
            <span className="tile-value">
              {loading ? '—' : t.value}
              <span className="tile-arrow" aria-hidden="true">→</span>
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}
