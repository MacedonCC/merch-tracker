'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-client';

interface Counts {
  onHand: number;
  readyToHandOver: number;
  linesToReorder: number;
  unpaidOrders: number;
  memberCount: number | null;
}

const EMPTY: Counts = { onHand: 0, readyToHandOver: 0, linesToReorder: 0, unpaidOrders: 0, memberCount: null };

const iconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function StockIcon() {
  return (
    <svg {...iconProps}>
      <path d="M8 4 L10 6 L12 5 L14 6 L16 4 L16 9 L14 9 L14 20 L10 20 L10 9 L8 9 Z" />
    </svg>
  );
}

function HandoversIcon() {
  return (
    <svg {...iconProps}>
      <path d="M3 8 L12 4 L21 8 L12 12 Z" />
      <path d="M3 8 L3 16 L12 20 L12 12" />
      <path d="M21 8 L21 16 L12 20" />
    </svg>
  );
}

function RestockIcon() {
  return (
    <svg {...iconProps}>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <rect x="9" y="2" width="6" height="4" rx="1" />
      <path d="M8.5 12.5 L11 15 L16 9" />
    </svg>
  );
}

function OrdersIcon() {
  return (
    <svg {...iconProps}>
      <path d="M6 3 H18 V19 L16 21 L14 19 L12 21 L10 19 L8 21 L6 19 Z" />
      <path d="M9 7 H15" />
      <path d="M9 11 H15" />
      <path d="M9 15 H13" />
    </svg>
  );
}

function MembersIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20 C3 15.5 5.5 13 9 13 C12.5 13 15 15.5 15 20" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M14.5 20 C14.7 16.5 16.3 14.5 19 14.5 C21.2 14.5 22.5 16.5 22.5 20" />
    </svg>
  );
}

export default function HomeTiles({ role }: { role: 'admin' | 'helper' }) {
  const isAdmin = role === 'admin';
  const [counts, setCounts] = useState<Counts>(EMPTY);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const [{ data: stock }, { data: orders }, membersResult] = await Promise.all([
        supabase.from('stock_overview').select('id, on_hand, suggested_order'),
        supabase.from('orders').select('quantity, payment_status, distributed_at, stock_item_id'),
        isAdmin
          ? supabase.from('members').select('id', { count: 'exact', head: true })
          : Promise.resolve({ count: null }),
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
        unpaidOrders: (orders ?? []).filter((o) => o.payment_status === 'pending').length,
        memberCount: 'count' in membersResult ? membersResult.count : null,
      });
      setLoading(false);
    })();
  }, [isAdmin]);

  const tiles = [
    {
      href: '/stock',
      category: 'Inventory',
      title: 'Stock',
      icon: <StockIcon />,
      description: 'Inventory levels for every item and size.',
      value: counts.onHand,
      label: 'garments on hand',
    },
    {
      href: '/handovers',
      category: 'Fulfilment',
      title: 'Handovers',
      icon: <HandoversIcon />,
      description: 'Paid orders ready to give out.',
      value: counts.readyToHandOver,
      label: 'ready to hand over',
    },
    {
      href: '/restock',
      category: 'Purchasing',
      title: 'Restock',
      icon: <RestockIcon />,
      description: 'What to order to hit target levels.',
      value: counts.linesToReorder,
      label: 'lines to reorder',
    },
    {
      href: '/orders',
      category: 'Sales',
      title: 'Orders',
      icon: <OrdersIcon />,
      description: 'Every order, paid or not.',
      value: counts.unpaidOrders,
      label: 'unpaid orders',
    },
    ...(isAdmin
      ? [{
          href: '/admin',
          category: 'Admin',
          title: 'Members',
          icon: <MembersIcon />,
          description: 'Who has access to the tracker.',
          value: counts.memberCount ?? 0,
          label: 'on the committee list',
        }]
      : []),
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
