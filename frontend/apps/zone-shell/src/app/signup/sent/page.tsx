import { ZoneFrame } from '@mc/features';
import { Card, PageHeader } from '@mc/ui';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

export default async function Sent({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const { email } = await searchParams;
  return (
    <ZoneFrame zone="shell" path="/signup/sent" zones={ZONES} requireAuth={false}>
      <PageHeader title="Check your e-mail" />
      <Card><p style={{ margin: 0 }}>We sent a link to <strong>{email}</strong>. Open it to create your hospital; it works for 24 hours.</p></Card>
    </ZoneFrame>
  );
}
