import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Msg91Sms, smsProviderFromEnv, SmsNotRegistered } from './sms.js';

// a stand-in for MSG91's Flow API: records what it was sent
const seen: { headers: Record<string, unknown>; body: any }[] = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    seen.push({ headers: req.headers, body });
    const ok = req.url === '/api/v5/flow/' && req.headers.authkey === 'k1';
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { type: 'success', message: 'req-123' } : { type: 'error', message: 'invalid authkey' }));
  });
});
let base = '';
beforeAll(async () => { await new Promise<void>((r) => server.listen(0, r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => server.close());

describe('SMS provider (review A-2)', () => {
  it('MSG91: sends the DLT template id and the variables by name, to an Indian number without the +', async () => {
    const r = await new Msg91Sms('k1', base).send({ to: '+919812345678', text: 'ignored by DLT', tenantSlug: 'citycare', template: { providerTemplateId: 'tpl_42', vars: { code: '123456' } } });
    expect(r.providerMessageId).toBe('req-123');
    expect(seen.at(-1)!.body).toEqual({ template_id: 'tpl_42', short_url: '0', recipients: [{ mobiles: '919812345678', code: '123456' }] });
  });

  it('MSG91: refuses free text (no registered template), foreign numbers, and reports provider errors', async () => {
    await expect(new Msg91Sms('k1', base).send({ to: '+919812345678', text: 'hi', tenantSlug: 'x' })).rejects.toBeInstanceOf(SmsNotRegistered);
    await expect(new Msg91Sms('k1', base).send({ to: '+447700900123', text: 'hi', tenantSlug: 'x', template: { providerTemplateId: 't', vars: {} } })).rejects.toThrow(/Indian mobile/);
    await expect(new Msg91Sms('wrong', base).send({ to: '+919812345678', text: 'hi', tenantSlug: 'x', template: { providerTemplateId: 't', vars: {} } })).rejects.toThrow(/MSG91 401: invalid authkey/);
  });

  it('SMS_PROVIDER picks the provider; msg91 needs its key', () => {
    const env = { ...process.env };
    process.env.SMS_PROVIDER = 'msg91';
    delete process.env.MSG91_AUTH_KEY;
    expect(() => smsProviderFromEnv()).toThrow(/MSG91_AUTH_KEY/);
    process.env.SMS_PROVIDER = 'twilio';
    expect(() => smsProviderFromEnv()).toThrow(/mailpit or msg91/);
    process.env = env;
  });
});
