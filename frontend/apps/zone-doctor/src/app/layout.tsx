import '@mc/ui/theme.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// staff only: never in search results
export const metadata: Metadata = { title: 'Doctor · MediCare', robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
