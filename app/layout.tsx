import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Merchandise Tracker',
  description: 'Club clothing stock and order management',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
