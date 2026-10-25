import { api, ApiError, origin } from '@mc/bff';
import { ZoneFrame } from '@mc/features';
import { Alert, Card, PageHeader } from '@mc/ui';
import { redirect } from 'next/navigation';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

/** The e-mail link: confirms the address and starts setting up the hospital, then follows its progress. */
export default async function Verify({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const error = await api('/api/tenant/v1/signup/verify', { body: { token: token ?? '' } }).then(() => null, (e) => (e instanceof ApiError ? e.message : 'Something went wrong'));
  if (!error) redirect(`${await origin()}/signup/status?token=${encodeURIComponent(token!)}`);
  return (
    <ZoneFrame zone="shell" path="/signup/verify" zones={ZONES} requireAuth={false}>
      <PageHeader title="Confirming your e-mail" />
      <Alert tone="error">{error}</Alert>
      <Card><a href="/signup">Sign up again</a></Card>
    </ZoneFrame>
  );
}
