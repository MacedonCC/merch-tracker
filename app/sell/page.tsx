import { redirect } from 'next/navigation';
import { resolveViewer } from '@/lib/member';
import { createServerSupabase } from '@/lib/supabase-server';
import Header from '@/components/Header';
import NotOnCommitteeList from '@/components/NotOnCommitteeList';
import SellFlow, { type SellItem } from '@/components/SellFlow';
import { initials, tidyName } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface OverviewRow {
  id: string;
  name: string;
  size: string;
  price: number;
  on_hand: number;
  committed: number;
  available: number;
}

interface MediaRow {
  id: string;
  image_url: string | null;
  wix_product_url: string | null;
}

export default async function SellPage() {
  const viewer = await resolveViewer();
  if (!viewer) redirect('/login');
  if (!viewer.member) return <NotOnCommitteeList email={viewer.email} />;

  const supabase = createServerSupabase();

  // stock_overview is the source of truth for available (see CLAUDE.md),
  // but it predates image_url / wix_product_url, so those come from
  // stock_items and are merged in by id.
  const [{ data: overview }, { data: media }, { data: names }] = await Promise.all([
    supabase.from('stock_overview').select('id, name, size, price, on_hand, committed, available'),
    supabase.from('stock_items').select('id, image_url, wix_product_url'),
    supabase.from('orders').select('customer_name'),
  ]);

  const mediaById = new Map(
    ((media ?? []) as MediaRow[]).map((m) => [m.id, m])
  );

  const items: SellItem[] = ((overview ?? []) as OverviewRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    size: row.size,
    price: Number(row.price) || 0,
    available: Number(row.available) || 0,
    image_url: mediaById.get(row.id)?.image_url ?? null,
    wix_product_url: mediaById.get(row.id)?.wix_product_url ?? null,
  }));

  // Distinct past customers, for the step 3 type-ahead. Deduped
  // case-insensitively so "jane smith" and "Jane Smith" are one option,
  // keeping whichever spelling was seen first.
  const seen = new Map<string, string>();
  for (const row of (names ?? []) as Array<{ customer_name: string | null }>) {
    const name = row.customer_name ? tidyName(row.customer_name) : '';
    if (!name) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) seen.set(key, name);
  }
  const customers = Array.from(seen.values()).sort((a, b) => a.localeCompare(b));

  return (
    <>
      <Header
        userEmail={viewer.member.email}
        fullName={viewer.member.full_name}
        role={viewer.member.role}
      />
      <div className="shell">
        <SellFlow
          items={items}
          customers={customers}
          sellerInitials={initials(viewer.member.email, viewer.member.full_name)}
        />
      </div>
    </>
  );
}
