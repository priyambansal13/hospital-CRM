import { pageMeta } from '@mc/features/seo';
import type { Metadata } from 'next';
import { Alert, Button, Card, Field, PageHeader } from '@mc/ui';
import { requestDemo } from '@/lib/demo-actions';
import { MarketingFrame, marketingOnly } from '@/lib/marketing-frame';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  await marketingOnly();
  return pageMeta({ title: 'Book a demo · MediCare', description: 'A 20-minute walk-through of MediCare on our sample hospital: booking, front desk, records, lab and billing, for your type of practice.', path: '/demo' });
}

const SEGMENT: Record<string, string> = { clinics: 'CLINIC', 'diagnostic-centres': 'DIAGNOSTIC', hospitals: 'HOSPITAL', chains: 'HOSPITAL' };
type Q = { error?: string; segment?: string; name?: string; email?: string; phone?: string; hospitalName?: string; city?: string; doctors?: string; message?: string };

/** A short form that creates a lead for MediCare's sales team (tenant-service /v1/leads). */
export default async function Demo({ searchParams }: { searchParams: Promise<Q> }) {
  await marketingOnly();
  const sp = await searchParams;
  const segment = SEGMENT[sp.segment ?? ''] ?? sp.segment ?? 'CLINIC';
  return (
    <MarketingFrame path="/demo" wide={false}>
      <PageHeader title="Book a demo" subtitle="We show you MediCare on our sample hospital, for your type of practice, in about 20 minutes." />
      {sp.error ? <Alert tone="error">{sp.error}</Alert> : null}
      <Card>
        <form action={requestDemo} className="mc-form" aria-label="Book a demo">
          <Field label="Your name" name="name" required defaultValue={sp.name} autoComplete="name" />
          <Field label="Work e-mail" name="email" type="email" required defaultValue={sp.email} autoComplete="email" />
          <Field label="Mobile" name="phone" type="tel" defaultValue={sp.phone} autoComplete="tel" hint="So we can call to fix a time" />
          <Field label="Hospital or clinic" name="hospitalName" required defaultValue={sp.hospitalName} autoComplete="organization" />
          <Field label="City" name="city" defaultValue={sp.city} autoComplete="address-level2" />
          <label className="mc-field"><span>Type of practice</span>
            <select name="segment" defaultValue={segment} required>
              <option value="CLINIC">Clinic</option><option value="DIAGNOSTIC">Diagnostic centre or lab</option><option value="HOSPITAL">Hospital or chain</option>
              <option value="DENTAL">Dental clinic</option><option value="EYE">Eye care</option><option value="OTHER">Something else</option>
            </select>
          </label>
          <Field label="Number of doctors" name="doctors" type="number" inputMode="numeric" pattern="[0-9]{1,6}" defaultValue={sp.doctors} />
          <label className="mc-field mc-field-wide"><span>Anything we should know? (optional)</span><textarea name="message" rows={3} maxLength={1000} defaultValue={sp.message} /></label>
          <Button>Request a demo</Button>
        </form>
        <p className="mc-meta" style={{ marginBottom: 0 }}>We use these details only to arrange the demo. Prefer to try it yourself? <a href="/signup">Start a free trial</a>.</p>
      </Card>
    </MarketingFrame>
  );
}
