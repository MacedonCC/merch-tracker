import type { Metadata } from 'next';
import './globals.css';
import Footer from '@/components/Footer';

export const metadata: Metadata = {
  title: 'MCC Clothing',
  description: 'Club clothing stock and order management',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-frame">
          <div className="app-main">{children}</div>
          <Footer />
        </div>
      </body>
    </html>
  );
}
