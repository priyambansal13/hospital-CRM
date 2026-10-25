import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Button, Card, Field, PageHeader, Table } from '@mc/ui';
import { saveEdition } from '@/lib/actions';
import { get } from '@/lib/console';
import { Flash } from '@/lib/flash';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

interface Edition { code: string; name: string; description: string | null; plans: number }

/** Editions: the kinds of hospital MediCare sells to; plans belong to one. */
export default async function Editions({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const caps = await zoneCapabilities('platform', '/platform/editions');
  const editions = await get<Edition[]>('/editions');
  return (
    <ZoneFrame zone="platform" path="/platform/editions" zones={ZONES}>
      <PageHeader title="Editions" subtitle="Kinds of hospital MediCare sells to. Each plan belongs to one edition." />
      <Flash {...await searchParams} />
      <Card>
        <Table rows={editions} empty="No editions." columns={[
          { header: 'Edition', cell: (e) => <><strong>{e.name}</strong><div className="mc-meta">{e.code}</div></> },
          { header: 'For', cell: (e) => e.description ?? '—' },
          { header: 'Plans', cell: (e) => e.plans },
        ]} />
      </Card>
      {can(caps, 'catalog:edit:tenant') ? (
        <Card title="Add or rename an edition">
          <form action={saveEdition} className="mc-form" aria-label="Edition">
            <Field label="Code" name="code" required placeholder="DENTAL_CHAIN" hint="An existing code renames that edition" pattern="[A-Za-z][A-Za-z0-9_]{2,39}" />
            <Field label="Name" name="name" required placeholder="Dental chain" />
            <Field label="For" name="description" placeholder="Single-specialty dental chains" />
            <Button>Save</Button>
          </form>
        </Card>
      ) : null}
    </ZoneFrame>
  );
}
