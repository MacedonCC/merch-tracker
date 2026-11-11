'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-client';
import { initials } from '@/lib/types';

const NAV_ITEMS = [
  { label: 'Home', href: '/' },
  { label: 'Sell', href: '/sell' },
  { label: 'Stock', href: '/stock' },
  { label: 'Restock', href: '/restock' },
  { label: 'Orders', href: '/orders' },
];

// Shown only when `role` is admin. Every page passes `role` from
// resolveViewer()'s members row, the same value /admin checks before
// rendering, so the tab and the page always agree. Hiding the tab is
// not the access control: /admin and every admin API route re-check
// the role on the server.
const ADMIN_ITEM = { label: 'Admin', href: '/admin' };

// Fired by PaymentMatchPanel after an approve/dismiss so the badge
// on the Admin tab catches up without a reload.
export const PAYMENT_MATCHES_CHANGED = 'payment-matches-changed';

export default function Header({
  userEmail,
  fullName,
  role,
}: {
  userEmail: string;
  fullName?: string | null;
  role: 'admin' | 'helper';
}) {
  const isAdmin = role === 'admin';
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [matchCount, setMatchCount] = useState(0);

  // Pairs on the Admin page's "Payment-link matches" card waiting for
  // a decision. Display only: a failed read just shows no badge.
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/payment-link-match/count', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && typeof data.count === 'number') setMatchCount(data.count);
      } catch { /* no badge */ }
    }
    load();
    window.addEventListener(PAYMENT_MATCHES_CHANGED, load);
    return () => { cancelled = true; window.removeEventListener(PAYMENT_MATCHES_CHANGED, load); };
  }, [isAdmin, pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  function isActive(href: string) {
    return href === '/' ? pathname === '/' : pathname.startsWith(href);
  }

  return (
    <header className="site-header">
      <div className="header-top">
        <div className="brand">
          <Image
            src="/mcc-logo.jpg"
            alt="Macedon Cricket Club logo"
            width={88}
            height={88}
            className="brand-logo"
            priority
          />
          <div>
            <h1>Macedon Cricket Club</h1>
            <p>Merchandise Tracker</p>
          </div>
        </div>
        <div className="avatar-wrap" ref={menuRef}>
          <button
            className="avatar"
            aria-label={`Account menu for ${userEmail}`}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            {initials(userEmail, fullName)}
          </button>
          {menuOpen && (
            <div className="avatar-menu" role="menu">
              <div className="avatar-menu-header">{userEmail}</div>
              {isAdmin && (
                <Link href="/admin" className="avatar-menu-item" role="menuitem" onClick={() => setMenuOpen(false)}>
                  Admin
                </Link>
              )}
              <button className="avatar-menu-item" role="menuitem" onClick={signOut}>
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
      <nav className="header-nav">
        <div className="header-nav-inner">
          {(isAdmin ? [...NAV_ITEMS, ADMIN_ITEM] : NAV_ITEMS).map((n) => (
            <Link key={n.href} href={n.href} className="nav-tab" data-active={isActive(n.href)}>
              {n.label}
              {n.href === ADMIN_ITEM.href && matchCount > 0 && (
                <span
                  className="nav-badge"
                  aria-label={`${matchCount} payment-link ${matchCount === 1 ? 'match' : 'matches'} to review`}
                  title={`${matchCount} payment-link ${matchCount === 1 ? 'match' : 'matches'} to review`}
                >
                  {matchCount > 99 ? '99+' : matchCount}
                </span>
              )}
            </Link>
          ))}
        </div>
      </nav>
    </header>
  );
}
