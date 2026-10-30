import { getSession } from '@mc/auth';
import { api } from '@mc/bff';
import { ZoneFrame, zoneCapabilities } from '@mc/features';
import { Button, Card, PageHeader } from '@mc/ui';
import { notFound } from 'next/navigation';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';
import { savePackageTests } from '../../detail-actions';

export const dynamic = 'force-dynamic';

interface Test { id: string; code: string; name: string; price: number; active: boolean }
interface Pkg { id: string; name: string; price: number; tests: { code: string; name: string; price: number }[] }

/** E-10: which tests a package contains (orders already placed keep what they had). */
export default async function PackageTests({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { id } = await params;
  await zoneCapabilities('admin', '/admin/lab-catalog');
  const { accessToken: token } = (await getSession())!;
  const cat = await api<{ tests: Test[]; packages: Pkg[] }>('/api/diagnostics/v1/admin/lab-catalog', { token });
  const p = cat.packages.find((x) => x.id === id);
  if (!p) notFound();
  const inPkg = new Set(p.tests.map((t) => t.code));
  return (
    <ZoneFrame zone="admin" path="/admin/lab-catalog" zones={ZONES}>
      <PageHeader title={p.name} subtitle={`₹${p.price} · ${p.tests.length} tests`} actions={<a href="/admin/lab-catalog">Lab catalog</a>} />
      <Flash {...await searchParams} />
      <Card title="Tests in this package">
        <form action={savePackageTests} className="mc-form">
          <input type="hidden" name="id" value={p.id} />
          <div className="mc-radios mc-field-wide">
            {cat.tests.map((t) => <label key={t.id} className="mc-check"><input type="checkbox" name="code" value={t.code} defaultChecked={inPkg.has(t.code)} /> <span>{t.name} <span className="mc-meta">{t.code} · ₹{t.price}{t.active ? '' : ' · off'}</span></span></label>)}
          </div>
          <Button>Save</Button>
        </form>
      </Card>
    </ZoneFrame>
  );
}
