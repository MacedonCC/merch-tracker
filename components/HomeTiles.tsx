'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { createClient } from '@/lib/supabase-client';
import {
  projectRestock,
  type RestockOrderRow,
  type RestockStockRow,
} from '@/lib/restock';

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
      // retired_at and wix_listed_at are on stock_items, not on the
      // stock_overview view, so they are read separately and merged by
      // id - the same shape the Stock page uses.
      const [{ data: stock }, { data: orders }, { data: meta }] = await Promise.all([
        supabase.from('stock_overview').select('id, name, size, price, on_hand, available, shortfall'),
        supabase
          .from('orders')
          .select('quantity, payment_status, distributed_at, stock_item_id, ordered_at'),
        supabase.from('stock_items').select('id, retired_at, wix_listed_at'),
      ]);

      const retired = new Set(
        (meta ?? []).filter((m) => m.retired_at).map((m) => m.id as string)
      );
      const listedAt = new Map(
        (meta ?? []).map((m) => [m.id as string, (m.wix_listed_at as string | null) ?? null])
      );
      const live = (stock ?? []).filter((s) => !retired.has(s.id as string));

      // Handovers are judged on every line, retired or not: an order
      // placed before a line was retired is still owed, and hiding the
      // stock that would settle it would lose the obligation.
      const onHandById = new Map((stock ?? []).map((s) => [s.id, s.on_hand as number]));

      const readyToHandOver = (orders ?? []).filter((o) => {
        if (o.payment_status !== 'paid' || o.distributed_at) return false;
        const onHand = o.stock_item_id ? onHandById.get(o.stock_item_id) : undefined;
        return onHand !== undefined && onHand >= o.quantity;
      }).length;

      // The same projection the /restock page runs, so the tile and the
      // page can never disagree. stock_overview.suggested_order is the
      // old target-level figure and still counts retired lines; reading
      // it here had the home page proposing five junior shirt sizes the
      // club no longer sells.
      const projection = projectRestock({
        stock: (stock ?? []) as unknown as RestockStockRow[],
        orders: (orders ?? []) as unknown as RestockOrderRow[],
        listedAt,
        retired,
      });

      setCounts({
        onHand: live.reduce((n, s) => n + (s.on_hand as number), 0),
        readyToHandOver,
        linesToReorder: projection.linesToOrder,
      });
      setLoading(false);
    })();
  }, []);

  const tiles = [
    {
      href: '/stock',
      category: 'Inventory',
      title: 'Stock',
      icon: (
        <Image
          src="/mcc-polo.png"
          alt=""
          aria-hidden="true"
          width={78}
          height={82}
          style={{ display: 'block' }}
        />
      ),
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
    <>
      {/* Primary action: most trips to this app at the ground are a sale,
          so it sits above the tiles rather than inside the grid. */}
      <Link href="/sell" className="sell-cta">
        <span aria-hidden="true">🏏</span>
        Sell an item
      </Link>
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
    </>
  );
}
