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
      title: 'Stock',
      description: 'Inventory levels for every item and size.',
      value: counts.onHand,
      label: 'garments on hand',
    },
    {
      href: '/handovers',
      title: 'Handovers',
      description: 'Paid orders ready to give out.',
      value: counts.readyToHandOver,
      label: 'ready to hand over',
    },
    {
      href: '/restock',
      title: 'Restock',
      description: 'What to order to hit target levels.',
      value: counts.linesToReorder,
      label: 'lines to reorder',
    },
    {
      href: '/orders',
      title: 'Orders',
      description: 'Every order, paid or not.',
      value: counts.unpaidOrders,
      label: 'unpaid orders',
    },
    ...(isAdmin
      ? [{
          href: '/admin',
          title: 'Members',
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
          <h3>{t.title}</h3>
          <p>{t.description}</p>
          <strong>{loading ? '—' : t.value}</strong>
          <small>{t.label}</small>
        </Link>
      ))}
    </div>
  );
}
