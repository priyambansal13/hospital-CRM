import { Inject, Injectable, Logger } from '@nestjs/common';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { conflict, DomainError, FieldCrypto, forbidden, notFound } from '@mc/nest-common';
import { type Actor, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { asUser, ToolError } from '../chat/tools.js';
import { LLM, type LlmClient } from '../llm/llm.js';
import { normaliseSoap, SOAP_PROMPT, SOAP_SCHEMA, SOAP_SYSTEM, type SoapNote, soapTurn } from './soap.js';

/** What the draft was checked against before the doctor sees it: nothing unmatched is dropped silently. */
export interface DraftChecks {
  medicines: { drug: string; strength: string; formulary: string | null }[];
  labTests: { testCode: string; name: string | null }[];
  icd10: { code: string; valid: boolean }[];
  safety: { allergies: { drug: string; allergy: string; level: string; reason: string }[]; interactions: { a: string; b: string; severity: string; effect: string; withCurrent: boolean }[]; duplicates: { a: string; b: string; drugClass: string }[]; allergiesChecked: boolean } | null;
}
export interface ScribeView {
  id: string; encounterId: string; status: string; createdAt: string; model: string | null;
  transcript: string; soap: SoapNote; checks: DraftChecks; final: SoapNote | null; edited: boolean | null;
}

const upstream = (e: unknown) => {
  if (e instanceof ToolError) return new DomainError((e as { status?: number }).status ?? 502, (e as { code?: string }).code ?? 'UPSTREAM', e.message);
  return e;
};

/**
 * The AI scribe (docs/AI-AGENTS.md §5.1–5.2, IMPLEMENTATION-PLAN.md Phase 25): a recorded consultation (with the
 * patient's consent) → transcript → structured SOAP draft, checked against the formulary, the test catalog, ICD-10 and
 * the deterministic prescription safety rules. The doctor takes it over into the visit notes, edits it and signs;
 * nothing enters the record before that. The visit is read with the doctor's own token (their access and audit).
 */
@Injectable()
export class ScribeService {
  private readonly log = new Logger('Scribe');
  constructor(private readonly db: TenantDbRouter, private readonly crypto: FieldCrypto, private readonly entitlements: EntitlementsClient, @Inject(LLM) private readonly llm: LlmClient) {}

  private aad = (id: string, part: string) => `assistant.clinical_drafts.${part}:${id}`;

  private async allowed(actor: Actor) {
    if (actor.kind !== 'staff') throw forbidden('STAFF_ONLY', 'the scribe is for doctors');
    const caps = await this.entitlements.capabilities(TenantContext.require().id, { id: actor.id, kind: actor.kind });
    if (!caps.features['ai.scribe']?.enabled) throw forbidden('FEATURE_NOT_IN_PLAN', 'the AI scribe is not in this hospital\'s plan');
  }

  async draft(actor: Actor, encounterId: string, recordingId: string): Promise<ScribeView> {
    await this.allowed(actor);
    const t = TenantContext.require();
    const ctx = { actor, tenant: t };
    const enc = await asUser<{ id: string; appointmentId: string; status: string; patient: { id: string }; scribeConsent: { at: string } | null }>(ctx, 'records', `/v1/encounters/${encounterId}`).catch((e) => { throw upstream(e); });
    if (enc.status !== 'OPEN') throw conflict('ENCOUNTER_SIGNED', 'this visit is signed');
    if (!enc.scribeConsent) throw conflict('CONSENT_REQUIRED', 'record the patient\'s consent first');
    const res = await fetch(`${process.env.SVC_URL_RECORDS ?? 'http://localhost:4410'}/internal/tenants/${t.id}/recordings/${recordingId}`, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, signal: AbortSignal.timeout(20_000) });
    const rec = res.ok ? ((await res.json()) as { encounterId: string; mimeType: string; contentBase64: string }) : null;
    if (!rec || rec.encounterId !== encounterId) throw notFound('recording');

    const started = Date.now();
    let transcript: string;
    let soap: SoapNote;
    let model: string;
    let usage = { input: 0, output: 0 };
    try {
      transcript = (await this.llm.transcribe(Buffer.from(rec.contentBase64, 'base64'), rec.mimeType)).text.trim();
      if (!transcript) throw new Error('empty transcript');
      const out = await this.llm.generate({ purpose: 'copilot', system: SOAP_SYSTEM, turns: [{ role: 'user', text: soapTurn(transcript) }], responseSchema: SOAP_SCHEMA, thinking: 'medium', maxOutputTokens: 2000, timeoutMs: 60_000 });
      soap = normaliseSoap(JSON.parse(out.text || 'null'));
      model = out.model;
      usage = { input: out.usage.input, output: out.usage.output };
    } catch (e) {
      this.log.warn(`${t.slug}: scribe failed: ${(e as Error).message}`);
      throw new DomainError(503, 'SCRIBE_UNAVAILABLE', 'the recording could not be turned into notes just now; write them yourself or try again');
    }
    const checks = await this.check(ctx, enc.patient.id, soap);

    const id = randomUUID();
    await this.db.tx(async (c) => {
      await c.query(`UPDATE clinical_drafts SET status = 'SUPERSEDED' WHERE encounter_id = $1 AND doctor_user_id = $2 AND kind = 'SOAP' AND status = 'DRAFT'`, [encounterId, actor.id]);
      await c.query(
        `INSERT INTO clinical_drafts (id, kind, appointment_id, patient_id, doctor_user_id, encounter_id, recording_id, draft_enc, sources, model, prompt_version, input_tokens, output_tokens, latency_ms)
         VALUES ($1,'SOAP',$2,$3,$4,$5,$6,$7,'[]',$8,$9,$10,$11,$12)`,
        [id, enc.appointmentId, enc.patient.id, actor.id, encounterId, recordingId, await this.crypto.encrypt(t.id, this.aad(id, 'draft'), JSON.stringify({ transcript, soap, checks })),
          model, SOAP_PROMPT.version, usage.input, usage.output, Date.now() - started]);
    });
    return (await this.latest(actor, encounterId))!;
  }

  /** Formulary, test catalog, ICD-10 and the deterministic safety rules, all through the owning services. */
  private async check(ctx: Parameters<typeof asUser>[0], patientId: string, soap: SoapNote): Promise<DraftChecks> {
    const meds = soap.plan.medications;
    const [safety, catalog, icd] = await Promise.all([
      meds.length
        ? asUser<DraftChecks['safety'] & { matches: { drugName: string; generic: string | null }[] }>(ctx, 'records', `/v1/patients/${patientId}/prescription-check`, { body: { items: meds.map((m) => ({ drugName: `${m.drug} ${m.strength}`.trim() })) } }).catch(() => null)
        : Promise.resolve(null),
      asUser<{ tests: { code: string; name: string }[]; packages: { code: string; name: string }[] }>(ctx, 'diagnostics', '/v1/public/lab-catalog').catch(() => ({ tests: [], packages: [] })),
      Promise.all(soap.assessment.filter((a) => a.icd10Suggestion).map(async (a) => {
        const hits = await asUser<{ code: string }[]>(ctx, 'records', `/v1/icd10?q=${encodeURIComponent(a.icd10Suggestion!)}`).catch(() => []);
        return { code: a.icd10Suggestion!, valid: hits.some((h) => h.code === a.icd10Suggestion) };
      })),
    ]);
    const all = [...catalog.tests, ...catalog.packages];
    return {
      medicines: meds.map((m, i) => ({ drug: m.drug, strength: m.strength, formulary: safety?.matches?.[i]?.generic ?? null })),
      labTests: soap.plan.labTests.map((l) => ({ testCode: l.testCode, name: all.find((x) => x.code === l.testCode)?.name ?? null })),
      icd10: icd,
      safety: safety ? { allergies: safety.allergies, interactions: safety.interactions, duplicates: safety.duplicates, allergiesChecked: safety.allergiesChecked } : null,
    };
  }

  async latest(actor: Actor, encounterId: string): Promise<ScribeView | null> {
    if (actor.kind !== 'staff') throw forbidden('STAFF_ONLY', 'the scribe is for doctors');
    const t = TenantContext.require();
    const { rows: [d] } = await this.db.query(`SELECT * FROM clinical_drafts WHERE encounter_id = $1 AND doctor_user_id = $2 AND kind = 'SOAP' AND status IN ('DRAFT','APPLIED') ORDER BY created_at DESC LIMIT 1`, [encounterId, actor.id]);
    if (!d) return null;
    const body = JSON.parse((await this.crypto.decrypt(t.id, this.aad(d.id, 'draft'), d.draft_enc)) ?? '{}');
    const final = d.final_enc ? JSON.parse((await this.crypto.decrypt(t.id, this.aad(d.id, 'final'), d.final_enc)) ?? 'null') : null;
    return { id: d.id, encounterId: d.encounter_id, status: d.status, createdAt: d.created_at, model: d.model, transcript: body.transcript, soap: body.soap, checks: body.checks, final, edited: d.edited };
  }

  /** The doctor took the (edited) draft over into the visit notes: keep what they took, and whether they changed it. */
  async apply(actor: Actor, draftId: string, finalRaw: unknown): Promise<ScribeView> {
    const t = TenantContext.require();
    const final = normaliseSoap(finalRaw);
    const { rows: [d] } = await this.db.query(`SELECT * FROM clinical_drafts WHERE id = $1 AND doctor_user_id = $2 AND kind = 'SOAP'`, [draftId, actor.id]);
    if (!d) throw notFound('draft');
    if (d.status !== 'DRAFT') throw conflict(`DRAFT_${d.status}`, 'this draft was already used or replaced');
    const body = JSON.parse((await this.crypto.decrypt(t.id, this.aad(d.id, 'draft'), d.draft_enc)) ?? '{}');
    const edited = JSON.stringify(normaliseSoap(body.soap)) !== JSON.stringify(final);
    await this.db.query(`UPDATE clinical_drafts SET status = 'APPLIED', final_enc = $2, edited = $3, applied_at = now() WHERE id = $1`, [draftId, await this.crypto.encrypt(t.id, this.aad(draftId, 'final'), JSON.stringify(final)), edited]);
    return (await this.latest(actor, d.encounter_id))!;
  }
}
