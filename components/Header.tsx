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
            </Link>
          ))}
        </div>
      </nav>
    </header>
  );
}
