import '@mc/ui/theme.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// private by default (sign-in, signup progress); the home page, pricing and signup opt in with pageMeta()
export const metadata: Metadata = { title: 'MediCare', description: 'Hospital CRM', robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
