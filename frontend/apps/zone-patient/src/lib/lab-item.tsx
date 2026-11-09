import 'server-only';
import { breadcrumbLd, describe, JsonLd, NO_INDEX, pageMeta, site, testCode, testLd, testSlug } from '@mc/features/seo';
import { ZoneFrame } from '@mc/features';
import { Card, PageHeader } from '@mc/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { catalog, type CatalogPackage, type CatalogTest } from './lab';
import { publicModules } from './modules';
import { ZONES } from './zones';

/** One lab test (/care/tests/<code>) or health package (/care/packages/<code>): price, preparation, booking link. */
type Item = { kind: 'test'; t: CatalogTest } | { kind: 'package'; p: CatalogPackage };

const load = cache(async (kind: 'test' | 'package', slug: string): Promise<Item | null> => {
  const code = testCode(slug);
  if (!code || !(await publicModules()).modules.includes('diagnostics')) return null;
  const cat = await catalog();
  if (kind === 'test') { const t = cat.tests.find((x) => x.code === code); return t ? { kind, t } : null; }
  const p = cat.packages.find((x) => x.code === code);
  return p ? { kind, p } : null;
});

const pathOf = (kind: 'test' | 'package', code: string) => `/care/${kind === 'test' ? 'tests' : 'packages'}/${testSlug(code)}`;
const sample = (t: CatalogTest) => (t.sampleType === 'NONE' ? 'done at the lab' : `${t.sampleType.toLowerCase()} sample`);

export async function labItemMeta(kind: 'test' | 'package', slug: string): Promise<Metadata> {
  const it = await load(kind, slug);
  if (!it) return NO_INDEX;
  const s = await site();
  if (it.kind === 'test') {
    const t = it.t;
    return pageMeta({
      title: `${t.name} test price ₹${t.price} · ${s.name}`,
      description: describe(`${t.name} at ${s.name}: ₹${t.price}, ${sample(t)}, report in about ${t.turnaroundHours} hours.`, t.fastingHours ? `Fast for ${t.fastingHours} hours before.` : null, 'Book online at the lab or a sample from home.'),
      path: pathOf('test', t.code),
    });
  }
  const p = it.p;
  return pageMeta({
    title: `${p.name} ₹${p.price} (${p.tests.length} tests) · ${s.name}`,
    description: describe(`${p.name} at ${s.name}: ${p.tests.length} tests for ₹${p.price}${p.worth > p.price ? ` (worth ₹${p.worth})` : ''}.`, p.description, 'Book online.'),
    path: pathOf('package', p.code),
  });
}

export async function LabItemPage({ kind, slug }: { kind: 'test' | 'package'; slug: string }) {
  const it = await load(kind, slug);
  if (!it) notFound();
  const s = await site();
  const name = it.kind === 'test' ? it.t.name : it.p.name;
  const code = it.kind === 'test' ? it.t.code : it.p.code;
  const price = it.kind === 'test' ? it.t.price : it.p.price;
  const book = it.kind === 'test' ? `/care/tests/book?test=${it.t.id}` : `/care/tests/book?pkg=${it.p.id}`;
  return (
    <ZoneFrame zone="patient" path="/care/tests" zones={ZONES} requireAuth={false}>
      <JsonLd data={[
        testLd(s, { name, path: pathOf(kind, code), price, category: it.kind === 'test' ? it.t.category : 'Health package', description: it.kind === 'package' ? it.p.description : null }),
        breadcrumbLd(s, [{ name: s.name, path: '/' }, { name: 'Lab tests', path: '/care/tests' }, { name, path: pathOf(kind, code) }]),
      ]} />
      <PageHeader title={name} subtitle={it.kind === 'test' ? it.t.category : `${it.p.tests.length} tests in one package`} />
      <Card>
        <p className="mc-stat" style={{ fontSize: '1.6rem', marginTop: 0 }}>₹{price}{it.kind === 'package' && it.p.worth > price ? <> <span className="mc-meta" style={{ textDecoration: 'line-through' }}>₹{it.p.worth}</span></> : null}</p>
        {it.kind === 'test' ? (
          <dl className="mc-dl">
            <dt>Sample</dt><dd>{sample(it.t)}</dd>
            <dt>Report</dt><dd>in about {it.t.turnaroundHours} hours</dd>
            {it.t.fastingHours ? <><dt>Fasting</dt><dd>{it.t.fastingHours} hours before</dd></> : null}
            {it.t.preparation ? <><dt>Before the test</dt><dd>{it.t.preparation}</dd></> : null}
          </dl>
        ) : (
          <>
            {it.p.description ? <p>{it.p.description}</p> : null}
            {it.p.preparation ? <p className="mc-meta">Before: {it.p.preparation}</p> : null}
            <ul>{it.p.tests.map((t) => <li key={t.code}><a href={pathOf('test', t.code)}>{t.name}</a></li>)}</ul>
          </>
        )}
        <a className="mc-btn mc-btn-primary" href={book}>Book this {kind}</a>
      </Card>
      <p><a href="/care/tests">← All lab tests</a></p>
    </ZoneFrame>
  );
}
