'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-client';
import { initials } from '@/lib/types';

const NAV = [
  { label: 'Home', href: '/' },
  { label: 'Stock', href: '/stock' },
  { label: 'Handovers', href: '/handovers' },
  { label: 'Restock', href: '/restock' },
  { label: 'Orders', href: '/orders' },
];

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
  const router = useRouter();
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
    <div className="topbar">
      <div className="brand">
        <Image
          src="/mcc-logo.jpg"
          alt="Macedon Cricket Club logo"
          width={44}
          height={44}
          className="brand-logo"
          priority
        />
        <div>
          <h1>Macedon Cricket Club</h1>
          <p>Merchandise Tracker</p>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <div className="tabs">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="tab" data-active={isActive(n.href)}>
              {n.label}
            </Link>
          ))}
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
                <button
                  className="avatar-menu-item"
                  role="menuitem"
                  onClick={() => { setMenuOpen(false); router.push('/admin'); }}
                >
                  Admin
                </button>
              )}
              <button className="avatar-menu-item" role="menuitem" onClick={signOut}>
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
