import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { CITY, env, patientOtp, staffLogin } from './helpers';

// Phase 15: Dr. Asha Rao's patient is in the lab with CBC + FBS. The technician enters a critical sugar → the doctor
// sees it first and acknowledges → the rest is entered → the pathologist verifies → the patient sees "Report ready",
// the results and downloads the PDF → the QR code's page says the report is genuine.
const PLATFORM = new URL('../..', import.meta.url).pathname;
const psql = (sql: string) => execFileSync('docker', ['compose', '--env-file', join(PLATFORM, '.env'), '-f', join(PLATFORM, 'infra/docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-qAt', '-U', 'postgres', '-d', 't_citycare', '-c', sql], { encoding: 'utf8' }).trim();
const G = 'http://localhost:61000';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function call(method: string, path: string, token?: string, body?: unknown, extra: Record<string, string> = {}) {
  const r = await fetch(G + path, { method, headers: { 'x-tenant-host': 'citycare.localhost', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}
const idem = () => ({ 'idempotency-key': crypto.randomUUID() });
async function staffToken(email: string) {
  const r = await fetch('http://localhost:61180/realms/medicare/protocol/openid-connect/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mc-dev-cli', username: email, password: env.DEV_STAFF_PASSWORD, scope: 'openid organization:citycare' }) });
  return ((await r.json()) as { access_token: string }).access_token;
}
const mail = async (q: string) => ((await (await fetch(`http://localhost:61825/api/v1/search?query=${encodeURIComponent(q)}`)).json()) as any).messages ?? [];
async function until<T>(fn: () => Promise<T | undefined | false>, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(500); }
  throw new Error('timed out');
}

const phone = `+9184${Date.now().toString().slice(-8)}`;
const who = `Meera Report ${phone.slice(-4)}`;
let order: { id: string; orderNo: string };
let verifyCode = '';

test.describe.serial('lab results', () => {
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    // a patient of Dr. Asha Rao (walk-in today), CBC + FBS ordered by her, paid, collected and received at the lab
    await call('POST', '/api/iam/v1/auth/otp/request', undefined, { phone });
    const code = await until(async () => (await mail(`to:${phone.slice(1)}@sms.medicare.local`)).find((m: any) => /^\d{6} is your/.test(m.Snippet))?.Snippet.slice(0, 6));
    const pt = (await call('POST', '/api/iam/v1/auth/otp/verify', undefined, { phone, code })).body.accessToken;
    const self = (await call('PUT', '/api/patient/v1/me/profile', pt, { fullName: who, dob: '1975-05-05', gender: 'FEMALE' })).body;
    const [desk, asha, lab] = await Promise.all(['desk', 'asha.rao', 'lab'].map((u) => staffToken(`${u}@citycare.test`)));
    const cat = (await call('GET', '/api/diagnostics/v1/public/lab-catalog')).body;
    const T = (c: string) => cat.tests.find((t: any) => t.code === c).id;
    const branch = (await call('GET', '/api/diagnostics/v1/public/lab-branches')).body.find((b: any) => b.name === 'Sector 44');
    const me = (await call('GET', '/api/scheduling/v1/me/doctor', asha)).body;
    await call('POST', '/api/scheduling/v1/desk/appointments', desk, { patientId: self.id, walkIn: { doctorId: me.id, branchId: branch.id } }, idem());
    order = await until(async () => { const r = await call('POST', '/api/diagnostics/v1/doctor/lab-orders', asha, { patientId: self.id, items: [{ testId: T('CBC') }, { testId: T('FBS') }] }, idem()); return r.status === 201 && r.body; });
    let slot: any;
    for (let d = 1; d < 25 && !slot; d++) {
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + d * 86_400_000));
      slot = (await call('GET', `/api/diagnostics/v1/public/lab-slots?branchId=${branch.id}&date=${day}`)).body.slots?.find((s: any) => s.left > 0);
    }
    await call('POST', `/api/diagnostics/v1/lab-orders/${order.id}/schedule`, pt, { branchId: branch.id, slotAt: slot.slotAt, paymentMode: 'AT_CLINIC' });
    psql(`UPDATE diagnostics.lab_orders SET slot_at = now() - interval '5 minutes', local_date = (now() AT TIME ZONE 'Asia/Kolkata')::date WHERE id = '${order.id}'`);
    await until(async () => (await call('POST', '/api/billing/v1/desk/collect', lab, { sourceType: 'LAB_ORDER', sourceId: order.id, method: 'CASH' }, idem())).status === 201);
    const o = await until(async () => { const r = (await call('GET', `/api/diagnostics/v1/lab-orders/${order.id}`, lab)).body; return r.paymentStatus === 'PAID' && r; });
    for (const s of o.samples) await call('POST', '/api/diagnostics/v1/lab/samples/collect', lab, { barcode: s.barcode });
    for (const s of o.samples) await call('POST', '/api/diagnostics/v1/lab/samples/receive', lab, { barcode: s.barcode });
  });

  test('technician enters a critical sugar; the doctor sees it first and acknowledges', async ({ page, browser }) => {
    await staffLogin(page, CITY, 'lab@citycare.test', '/lab/pending');
    await expect(page.getByRole('heading', { name: 'Pending results' })).toBeVisible();
    await page.getByRole('link', { name: order.orderNo }).click();
    await expect(page.getByRole('heading', { name: `${who} · ${order.orderNo}` })).toBeVisible();
    await page.getByLabel('Fasting blood sugar Glucose, fasting').or(page.getByLabel(/Glucose, fasting/)).fill('452');
    await page.getByRole('button', { name: 'Save results' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('Results saved');
    await expect(page.getByRole('row', { name: /Glucose, fasting/ })).toContainText('CRITICAL high');
    await expect(page.locator('.mc-alert-error')).toContainText('Dr. Asha Rao has been alerted');

    const doc = await (await browser.newContext()).newPage();
    await staffLogin(doc, CITY, 'asha.rao@citycare.test', '/doctor/lab-results');
    const alerts = doc.locator('.mc-card', { hasText: 'Critical values' });
    const row = alerts.getByRole('row', { name: new RegExp(who) });
    await expect(row).toContainText('452 mg/dL');
    await doc.getByRole('link', { name: new RegExp(who) }).first().click();
    await expect(doc.getByRole('row', { name: /Glucose, fasting/ })).toContainText('452');
    await expect(doc.getByRole('row', { name: /Haemoglobin/ })).toContainText('pending');
    await doc.getByRole('link', { name: 'Acknowledge critical values' }).click();
    await doc.locator('.mc-card', { hasText: 'Critical values' }).getByRole('row', { name: new RegExp(who) }).getByRole('button', { name: 'Acknowledge' }).click();
    await expect(doc.locator('.mc-alert-success')).toContainText('Critical value acknowledged');
    await expect(doc.getByRole('row', { name: new RegExp(`${who}.*452`) })).toHaveCount(0);
  });

  test('the rest is entered and the pathologist verifies and publishes', async ({ page }) => {
    await staffLogin(page, CITY, 'lab@citycare.test', `/lab/orders/${order.id}`);
    await page.getByLabel(/Haemoglobin/).fill('11.2');
    await page.getByLabel(/WBC count/).fill('7.5');
    await page.getByLabel(/Platelet count/).fill('250');
    await page.getByRole('button', { name: 'Save results' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('ready for the pathologist');
    await expect(page.getByRole('row', { name: /Haemoglobin/ })).toContainText('low');
    await expect(page.getByRole('button', { name: 'Verify and publish report' })).toHaveCount(0); // technicians cannot verify

    await page.context().clearCookies();
    await staffLogin(page, CITY, 'path@citycare.test', `/lab/orders/${order.id}`);
    await expect(page.getByText('to verify')).toBeVisible();
    await page.getByRole('button', { name: 'Verify and publish report' }).click();
    await expect(page.locator('.mc-alert-success')).toContainText('Report verified and published (version 1; 2 abnormal, 1 critical)');
    const reports = page.locator('.mc-card', { hasText: 'Version 1' });
    await expect(reports).toContainText('verified by Dr. Prakash Path');
    verifyCode = (await reports.textContent())!.match(/code ([A-Z0-9]{8})/)![1];
    const pdf = await page.request.get(`${CITY}/lab/orders/${order.id}/report`);
    expect(pdf.status()).toBe(200);
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('the patient gets "report ready", sees the results and downloads the report; the QR page verifies it', async ({ page }) => {
    const sms = await until(async () => (await mail(`to:${phone.slice(1)}@sms.medicare.local`)).find((m: any) => m.Snippet.includes(order.orderNo) && /new document/.test(m.Snippet)));
    expect(sms.Snippet).not.toMatch(/452|glucose/i);

    await page.goto(`${CITY}/login?next=${encodeURIComponent('/care/lab-orders')}`);
    await patientOtp(page, phone);
    const card = page.getByRole('article', { name: `Lab order ${order.orderNo}` });
    await expect(card).toContainText('Report ready');
    await card.getByRole('link', { name: 'View results' }).click();
    await expect(page.getByRole('heading', { name: `Lab report · ${order.orderNo}` })).toBeVisible();
    await expect(page.getByRole('row', { name: /Glucose, fasting/ })).toContainText('far above range');
    await expect(page.getByRole('row', { name: /WBC count/ })).toContainText('in range');
    await expect(page.getByText('2 values are outside the usual range')).toBeVisible();
    const pdf = await page.request.get(`${CITY}/care/lab-orders/${order.id}/report`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('application/pdf');

    await page.context().clearCookies();
    await page.goto(`${CITY}/care/verify/${verifyCode}`);
    await expect(page.locator('.mc-alert-success')).toContainText('Genuine report issued by');
    await expect(page.getByText(order.orderNo)).toBeVisible();
    await expect(page.getByText(who)).toHaveCount(0); // initials only
    await page.goto(`${CITY}/care/verify/NOTACODE1`);
    await expect(page.locator('.mc-alert-error')).toContainText('No report with this code');
  });
});
