import { getBranding } from '@mc/bff';
import { ImageResponse } from 'next/og';
import { PLATFORM_SLUG } from '@/lib/site';

export const dynamic = 'force-dynamic';

const colour = (c: unknown, fallback: string) => (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback);

/**
 * The sharing card (1200×630) a link to any public page shows on WhatsApp, LinkedIn and search results, unless the page
 * has its own image (a doctor's photo): the hospital's name in its own colours. Nothing but the name and colours.
 */
export async function GET() {
  const b = await getBranding().catch(() => null);
  if (!b) return new Response('Not found\n', { status: 404 });
  const platform = b.slug === PLATFORM_SLUG;
  const brand = colour(b.branding.primaryColor, '#0f766e');
  const accent = colour(b.branding.accentColor, '#f59e0b');
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 72, color: '#fff', background: `linear-gradient(120deg, ${brand}, ${brand} 55%, ${accent})` }}>
        <div style={{ display: 'flex', width: 72, height: 10, borderRadius: 5, background: accent }} />
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: b.name.length > 28 ? 64 : 84, fontWeight: 800, letterSpacing: -2, lineHeight: 1.05 }}>{b.name}</div>
          <div style={{ fontSize: 36, marginTop: 20, opacity: 0.92 }}>{platform ? 'Hospital and clinic software: booking, records, lab and billing' : 'Book doctors and lab tests online'}</div>
        </div>
        <div style={{ fontSize: 26, opacity: 0.8 }}>{platform ? 'Free trial · Made for India' : 'See free times · Pay online · Reports on your phone'}</div>
      </div>
    ),
    { width: 1200, height: 630, headers: { 'cache-control': 'public, max-age=86400' } },
  );
}
