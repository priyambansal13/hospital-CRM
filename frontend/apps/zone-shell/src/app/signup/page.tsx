import { ZoneFrame } from '@mc/features';
import { Alert, Button, Card, Field, PageHeader } from '@mc/ui';
import { signup } from '@/lib/signup-actions';
import { inr, publicPlans } from '@/lib/site';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

type Q = { plan?: string; error?: string; hospitalName?: string; slug?: string; adminName?: string; adminEmail?: string; phone?: string };

/** Self-serve signup: hospital name, its web address, the owner, the plan. */
export default async function Signup({ searchParams }: { searchParams: Promise<Q> }) {
  const sp = await searchParams;
  const plans = (await publicPlans()).filter((p) => p.trialDays > 0);
  return (
    <ZoneFrame zone="shell" path="/signup" zones={ZONES} requireAuth={false}>
      <PageHeader title="Start your free trial" subtitle="Your own MediCare in a few minutes: online booking, records and more. No card needed." />
      {sp.error ? <Alert tone="error">{sp.error}</Alert> : null}
      <Card>
        <form action={signup} className="mc-form" aria-label="Sign up">
          <Field label="Hospital or clinic name" name="hospitalName" required defaultValue={sp.hospitalName} placeholder="Lotus Family Clinic" />
          <Field label="Web address" name="slug" required defaultValue={sp.slug} placeholder="lotusclinic" pattern="[a-zA-Z][a-zA-Z0-9-]{2,30}" hint="Your patients book at <name>.medicare.app (letters, digits, dashes)" />
          <Field label="Your name" name="adminName" required defaultValue={sp.adminName} autoComplete="name" />
          <Field label="Work e-mail" name="adminEmail" type="email" required defaultValue={sp.adminEmail} autoComplete="email" hint="We send a link to confirm it; you sign in with it" />
          <Field label="Mobile (optional)" name="phone" type="tel" defaultValue={sp.phone} autoComplete="tel" />
          <label className="mc-field"><span>Plan</span>
            <select name="plan" defaultValue={sp.plan ?? plans[0]?.code} required>
              {plans.map((p) => <option key={p.code} value={p.code}>{p.name}: {inr(p.listPrice)}/month after a {p.trialDays}-day trial</option>)}
            </select>
          </label>
          <Button>Create my hospital</Button>
        </form>
        <p className="mc-meta" style={{ marginBottom: 0 }}><a href="/pricing">Compare plans</a></p>
      </Card>
    </ZoneFrame>
  );
}
