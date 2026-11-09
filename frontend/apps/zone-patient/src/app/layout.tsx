import '@mc/ui/theme.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// private by default: public pages (doctors, specialties, branches, tests) opt in with pageMeta()
export const metadata: Metadata = { title: 'Patient · MediCare', robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
