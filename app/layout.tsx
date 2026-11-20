import './globals.css';
import type { Metadata, Viewport } from 'next';
import Nav from '@/components/Nav';
import RegisterSW from '@/components/RegisterSW';

export const metadata: Metadata = { title: 'Zecca', description: 'Carte XRPL non-custodiale (testnet)' };
export const viewport: Viewport = { themeColor: '#12403A' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="fr"><body><RegisterSW /><Nav />{children}</body></html>;
}
