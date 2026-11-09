import { LabItemPage, labItemMeta } from '@/lib/lab-item';

export const dynamic = 'force-dynamic';

export const generateMetadata = ({ params }: { params: Promise<{ slug: string }> }) => params.then(({ slug }) => labItemMeta('test', slug));
export default async function Test({ params }: { params: Promise<{ slug: string }> }) {
  return <LabItemPage kind="test" slug={(await params).slug} />;
}
