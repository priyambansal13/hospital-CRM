import { Card, PageHeader } from '@mc/ui';
import { MarketingFrame, marketingOnly } from '@/lib/marketing-frame';

export const dynamic = 'force-dynamic';

/** After a demo request (not indexed: the layout says noindex). */
export default async function DemoThanks() {
  await marketingOnly();
  return (
    <MarketingFrame path="/demo/thanks" wide={false}>
      <PageHeader title="Thank you" subtitle="We have your request and will contact you to fix a time." />
      <Card>
        <p style={{ marginTop: 0 }}>Meanwhile, you can look around:</p>
        <ul><li><a href="/features">What MediCare does</a></li><li><a href="/pricing">Plans and prices</a></li><li><a href="/security">Security and privacy</a></li></ul>
      </Card>
    </MarketingFrame>
  );
}
