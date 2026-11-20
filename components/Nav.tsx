'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { getMe, logout, type User } from '@/lib/passkey';

const LINKS = [['/card', 'Ma carte'], ['/terminal', 'Terminal'], ['/merchant', 'Paiements reçus']];

export default function Nav() {
  const path = usePathname();
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => { getMe().then(setUser).catch(() => {}); }, [path]);
  return (
    <nav className="nav" aria-label="Navigation principale">
      <Link href="/" className="logo">Zecca</Link>
      {LINKS.map(([href, label]) => (
        <Link key={href} href={href} className="l" aria-current={path === href ? 'page' : undefined}>{label}</Link>
      ))}
      {user
        ? <button className="ghost" onClick={async () => { await logout(); location.href = '/'; }}>{user.name} · Déconnexion</button>
        : <Link href="/login" className="l">Connexion</Link>}
    </nav>
  );
}
