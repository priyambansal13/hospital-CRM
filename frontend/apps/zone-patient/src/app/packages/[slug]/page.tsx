import { LabItemPage, labItemMeta } from '@/lib/lab-item';

export const dynamic = 'force-dynamic';

export const generateMetadata = ({ params }: { params: Promise<{ slug: string }> }) => params.then(({ slug }) => labItemMeta('package', slug));
export default async function Package({ params }: { params: Promise<{ slug: string }> }) {
  return <LabItemPage kind="package" slug={(await params).slug} />;
}
