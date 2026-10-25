import { Injectable } from '@nestjs/common';
import { EventTypes, type LabCriticalValue, type LabReportPublished, Topics } from '@mc/contracts';
import { conflict, DomainError, forbidden, notFound } from '@mc/nest-common';
import { type Actor, addToOutbox, envelope, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuditClient, CareAccessClient } from './clients.js';
import type { RefRange } from './default-catalog.js';
import { type Flag, flagValue, isAbnormal, isCritical, parametersOf, parseValue, rangeFor } from './flags.js';
import { LabService } from './lab.service.js';
import { reportPdf } from './report-pdf.js';

const age = (dob: Date | string | null) => {
  if (!dob) return null;
  const d = new Date(dob);
  const n = new Date();
  let y = n.getUTCFullYear() - d.getUTCFullYear();
  if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) y--;
  return y;
};
const webBase = (host: string) => (process.env.PUBLIC_WEB_URL ?? `http://{host}:${process.env.WEB_PORT ?? '3400'}`).replace('{host}', host);

/**
 * Results and reports (docs/LLD.md §10.2): entry with reference-range flags → (critical values alert the ordering
 * doctor at once) → pathologist verifies → report PDF with a QR verification code, stored in the patient's record →
 * report.published. Corrections after publishing are amendments: a new report version, the old one superseded.
 */
@Injectable()
export class ResultsService {
  constructor(private readonly db: TenantDbRouter, private readonly lab: LabService, private readonly audit: AuditClient, private readonly care: CareAccessClient) {}

  private tid() { return TenantContext.require().id; }
  /** Names printed on reports and shown to patients (the token carries only the email); cached per tenant and user. */
  private readonly names = new Map<string, { name: string; at: number }>();
  private staffName(actor: Actor) { return this.names.get(`${this.tid()}:${actor.id}`)?.name ?? actor.email ?? 'Lab staff'; }
  private async loadName(actor: Actor) {
    const key = `${this.tid()}:${actor.id}`;
    const hit = this.names.get(key);
    if (actor.kind !== 'staff' || (hit && Date.now() - hit.at < 10 * 60_000)) return;
    const res = await fetch(`${process.env.SVC_URL_IAM ?? 'http://localhost:4402'}/internal/tenants/${this.tid()}/staff/${actor.id}`, {
      headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    const name = res?.ok ? ((await res.json()) as { name: string | null }).name : null;
    if (name) this.names.set(key, { name, at: Date.now() });
  }

  /** What to enter for an order: each test's parameters, ranges for this patient's sex, and current values. */
  async sheet(c: Queryable, orderId: string) {
    const o = await this.lab.row(c, orderId);
    if (!o) throw notFound('lab order');
    const { rows: items } = await c.query(`SELECT i.*, t.reference_ranges FROM lab_order_items i JOIN lab_tests t ON t.id = i.test_id WHERE i.order_id = $1 ORDER BY i.test_name`, [orderId]);
    const { rows: results } = await c.query('SELECT * FROM lab_results WHERE order_id = $1', [orderId]);
    const { rows: reports } = await c.query('SELECT id, version, document_id, verified_by_name, verified_at, superseded_by, amendment_reason, abnormal_count, critical_count, verify_code FROM lab_reports WHERE order_id = $1 ORDER BY version', [orderId]);
    const { rows: alerts } = await c.query('SELECT * FROM critical_alerts WHERE order_id = $1', [orderId]);
    return {
      order: await this.lab.dto(c, o),
      collectedAt: o.collected_at, dueAt: o.due_at, overdue: !!o.tat_breached_at,
      tests: items.map((i) => {
        const ranges = i.reference_ranges as RefRange[];
        return {
          itemId: i.id, code: i.test_code, name: i.test_name, status: i.status,
          parameters: parametersOf(ranges).map((p) => {
            const rg = rangeFor(ranges, p, o.patient_gender);
            const r = results.find((x) => x.item_id === i.id && x.parameter === p);
            return { parameter: p, unit: rg?.unit || null, refLow: rg?.low ?? null, refHigh: rg?.high ?? null, value: r?.value ?? null, flag: r?.flag ?? null, enteredBy: r?.entered_by_name ?? null, critical: r ? isCritical(r.flag) : false, acknowledged: r ? alerts.find((a) => a.result_id === r.id)?.acknowledged_at ?? null : null };
          }),
        };
      }),
      reports: reports.map((r) => ({ id: r.id, version: r.version, documentId: r.document_id, verifiedBy: r.verified_by_name, verifiedAt: r.verified_at, superseded: !!r.superseded_by, amendmentReason: r.amendment_reason, abnormal: r.abnormal_count, critical: r.critical_count, verifyCode: r.verify_code })),
    };
  }

  async getSheet(actor: Actor, orderId: string) {
    const c = await this.db.current();
    const s = await this.sheet(c, orderId);
    await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: this.staffName(actor), action: 'READ', resourceType: 'LAB_RESULTS', resourceId: orderId, patientId: s.order.patient.id, purpose: 'TREATMENT' });
    return s;
  }

  /** Apply values (insert or correct with history); flags; new critical values raise alerts. Inside a transaction. */
  private async apply(c: Queryable, actor: Actor, o: any, entries: { itemId: string; parameter: string; value: string }[], reason: string | null) {
    const { rows: items } = await c.query(`SELECT i.*, t.reference_ranges FROM lab_order_items i JOIN lab_tests t ON t.id = i.test_id WHERE i.order_id = $1`, [o.id]);
    const changed: string[] = [];
    for (const e of entries) {
      const item = items.find((i) => i.id === e.itemId);
      if (!item) throw new DomainError(422, 'UNKNOWN_ITEM', 'that test is not on this order');
      const ranges = item.reference_ranges as RefRange[];
      if (!parametersOf(ranges).includes(e.parameter)) throw new DomainError(422, 'UNKNOWN_PARAMETER', `${item.test_name} does not report "${e.parameter}"`);
      if (!e.value.trim()) continue;
      const range = rangeFor(ranges, e.parameter, o.patient_gender);
      const parsed = parseValue(e.value, range);
      if (!parsed.ok) throw new DomainError(422, parsed.code, `${item.test_name}, ${e.parameter}: ${parsed.message}`, { itemId: item.id, parameter: e.parameter });
      const value = parsed.value;
      const f = flagValue(value, range);
      const { rows: [prev] } = await c.query('SELECT * FROM lab_results WHERE item_id = $1 AND parameter = $2 FOR UPDATE', [item.id, e.parameter]);
      if (prev && prev.value === value) continue;
      let resultId: string;
      if (prev) {
        await c.query('INSERT INTO lab_result_history (id, result_id, value, flag, changed_by, changed_by_name, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), prev.id, prev.value, prev.flag, actor.id, this.staffName(actor), reason]);
        await c.query(`UPDATE lab_results SET value = $2, value_num = $3, unit = $4, ref_low = $5, ref_high = $6, flag = $7, entered_by = $8, entered_by_name = $9, entered_at = now() WHERE id = $1`,
          [prev.id, value, f.valueNum, f.unit, f.refLow, f.refHigh, f.flag, actor.id, this.staffName(actor)]);
        resultId = prev.id;
      } else {
        resultId = randomUUID();
        await c.query(`INSERT INTO lab_results (id, order_id, item_id, parameter, value, value_num, unit, ref_low, ref_high, flag, entered_by, entered_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [resultId, o.id, item.id, e.parameter, value, f.valueNum, f.unit, f.refLow, f.refHigh, f.flag, actor.id, this.staffName(actor)]);
      }
      changed.push(`${item.test_code}:${e.parameter}`);
      if (isCritical(f.flag as Flag)) await this.raiseCritical(c, o, resultId, item.test_name, e.parameter);
    }
    // a test is RESULTED when all its parameters have a value
    for (const i of items) {
      const { rows: [{ n }] } = await c.query('SELECT count(*)::int AS n FROM lab_results WHERE item_id = $1', [i.id]);
      if (n >= parametersOf(i.reference_ranges as RefRange[]).length && i.status !== 'RESULTED') await c.query(`UPDATE lab_order_items SET status = 'RESULTED' WHERE id = $1`, [i.id]);
    }
    return changed;
  }

  private async raiseCritical(c: Queryable, o: any, resultId: string, testName: string, parameter: string) {
    const alertId = randomUUID();
    const { rowCount } = await c.query(`INSERT INTO critical_alerts (id, order_id, result_id, notify_user_id) VALUES ($1,$2,$3,$4)
      ON CONFLICT (result_id) DO UPDATE SET acknowledged_at = NULL, acknowledged_by = NULL, acknowledged_by_name = NULL, created_at = now()`,
      [alertId, o.id, resultId, o.ordered_by_doctor_id ? o.booked_by : null]);
    if (!rowCount) return;
    const { rows: [a] } = await c.query('SELECT id FROM critical_alerts WHERE result_id = $1', [resultId]);
    const data: LabCriticalValue = { alertId: a.id, orderId: o.id, orderNo: o.order_no, patientId: o.patient_id, patientName: o.patient_name, patientMrn: o.patient_mrn, testName, parameter, orderedByUserId: o.ordered_by_doctor_id ? o.booked_by : null, orderedByName: o.ordered_by_name };
    await addToOutbox(c, Topics.diagnostics, o.id, envelope(EventTypes.labCriticalValue, data, { tenantId: this.tid(), subject: a.id }));
  }

  /** Lab technician (or pathologist) enters results; all tests resulted → RESULTS_ENTERED. Not after publishing. */
  async enter(actor: Actor, orderId: string, entries: { itemId: string; parameter: string; value: string }[]) {
    await this.loadName(actor);
    await this.db.tx(async (c) => {
      const o = await this.lab.row(c, orderId, true);
      if (!o) throw notFound('lab order');
      if (o.status === 'REPORT_PUBLISHED') throw conflict('REPORT_PUBLISHED', 'the report is published; a pathologist can amend it');
      if (!['IN_LAB', 'RESULTS_ENTERED'].includes(o.status)) throw conflict('INVALID_STATE_TRANSITION', 'results can be entered once the samples are in the lab');
      const changed = await this.apply(c, actor, o, entries, null);
      const { rows: [{ open }] } = await c.query(`SELECT count(*)::int AS open FROM lab_order_items WHERE order_id = $1 AND status <> 'RESULTED'`, [orderId]);
      if (!open && o.status !== 'RESULTS_ENTERED') {
        await c.query(`UPDATE lab_orders SET status = 'RESULTS_ENTERED', version = version + 1, updated_at = now() WHERE id = $1`, [orderId]);
        await this.lab.emit(c, EventTypes.labResultsEntered, await this.lab.row(c, orderId));
      }
      if (changed.length) await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: this.staffName(actor), action: 'UPDATE', resourceType: 'LAB_RESULTS', resourceId: orderId, patientId: o.patient_id, purpose: 'TREATMENT', changes: changed.slice(0, 40) });
    });
    return this.sheet(await this.db.current(), orderId);
  }

  /** Pathologist verifies → report PDF → stored in the patient's record → REPORT_PUBLISHED (+ report.published). */
  async verify(actor: Actor, orderId: string) {
    await this.loadName(actor);
    const c0 = await this.db.current();
    const o = await this.lab.row(c0, orderId);
    if (!o) throw notFound('lab order');
    if (o.status !== 'RESULTS_ENTERED') throw conflict('INVALID_STATE_TRANSITION', o.status === 'REPORT_PUBLISHED' ? 'already verified; amend it instead' : 'enter all results first');
    return this.publish(actor, o, null);
  }

  /** Correct a published report: values change (history kept), a new version supersedes the old one. */
  async amend(actor: Actor, orderId: string, reason: string, entries: { itemId: string; parameter: string; value: string }[]) {
    await this.loadName(actor);
    const c0 = await this.db.current();
    const o = await this.lab.row(c0, orderId);
    if (!o) throw notFound('lab order');
    if (o.status !== 'REPORT_PUBLISHED') throw conflict('NOT_PUBLISHED', 'only a published report can be amended');
    const changed = await this.db.tx((c) => this.apply(c, actor, o, entries, reason));
    if (!changed.length) {
      // a retry: values changed by an earlier amendment whose report could not be stored (records unavailable) are
      // published now, so the PDF never stays behind the values (docs/ROLE-FLOWS-AND-GAPS.md D-6)
      const { rows: [pending] } = await c0.query(`SELECT 1 FROM lab_results r WHERE r.order_id = $1 AND r.entered_at > (SELECT max(verified_at) FROM lab_reports WHERE order_id = $1) LIMIT 1`, [orderId]);
      if (!pending) throw new DomainError(422, 'NOTHING_TO_AMEND', 'change at least one value');
      return this.publish(actor, o, { reason, changed: ['republished'] });
    }
    return this.publish(actor, o, { reason, changed });
  }

  private async publish(actor: Actor, o: any, amendment: { reason: string; changed: string[] } | null) {
    const t = TenantContext.require();
    const c = await this.db.current();
    const s = await this.sheet(c, o.id);
    const previous = s.reports.filter((r) => !r.superseded).at(-1) ?? null;
    const version = (s.reports.at(-1)?.version ?? 0) + 1;
    const flags = s.tests.flatMap((x) => x.parameters.map((p) => p.flag).filter(Boolean)) as Flag[];
    const abnormal = flags.filter(isAbnormal).length;
    const critical = flags.filter(isCritical).length;
    const verifyCode = randomBytes(6).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X');
    const pdf = await reportPdf({
      hospital: t.name, branch: o.branch_name ?? '', orderNo: o.order_no, version, verifyCode, verifyUrl: `${webBase(t.hosts[0])}/care/verify/${verifyCode}`,
      patient: { name: o.patient_name, mrn: o.patient_mrn, age: age(o.patient_dob), sex: o.patient_gender }, referredBy: o.ordered_by_name,
      collectedAt: o.collected_at ? new Date(o.collected_at) : null, reportedAt: new Date(), verifiedBy: this.staffName(actor),
      amendment: amendment && previous ? { replaces: previous.version, reason: amendment.reason } : null,
      tests: s.tests.map((x) => ({ name: x.name, results: x.parameters.filter((p) => p.value != null).map((p) => ({ parameter: p.parameter, value: p.value!, unit: p.unit, refLow: p.refLow, refHigh: p.refHigh, flag: p.flag! })) })),
    });
    // into the patient's record (records-service puts it in the hospital's bucket, on the timeline)
    const res = await fetch(`${process.env.SVC_URL_RECORDS ?? 'http://localhost:4410'}/internal/tenants/${t.id}/documents`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' },
      body: JSON.stringify({
        patientId: o.patient_id, type: 'LAB_REPORT', title: `Lab report ${o.order_no}${version > 1 ? ` (v${version})` : ''}`, mimeType: 'application/pdf', contentBase64: pdf.toString('base64'),
        relatedType: 'LAB_ORDER', relatedId: o.id, issuedOn: new Date().toISOString().slice(0, 10), byUserId: actor.id, byName: this.staffName(actor), supersedes: previous?.documentId ?? null,
        timeline: { kind: 'REPORT', refId: o.id, title: `Lab report ${o.order_no}`, summary: { abnormal, critical, version, orderNo: o.order_no } },
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!res?.ok) throw new DomainError(502, 'RECORDS_UNAVAILABLE', 'could not store the report; try again');
    const { documentId } = (await res.json()) as { documentId: string };

    return this.db.tx(async (tx) => {
      const cur = await this.lab.row(tx, o.id, true);
      if (amendment ? cur.status !== 'REPORT_PUBLISHED' : cur.status !== 'RESULTS_ENTERED') throw conflict('VERSION_CONFLICT', 'the order changed meanwhile; reload');
      const reportId = randomUUID();
      await tx.query(`INSERT INTO lab_reports (id, order_id, version, verify_code, document_id, pdf, sha256, abnormal_count, critical_count, verified_by, verified_by_name, amendment_reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [reportId, o.id, version, verifyCode, documentId, pdf, createHash('sha256').update(pdf).digest('hex'), abnormal, critical, actor.id, this.staffName(actor), amendment?.reason ?? null]);
      if (previous) await tx.query('UPDATE lab_reports SET superseded_by = $2 WHERE id = $1', [previous.id, reportId]);
      await tx.query(`UPDATE lab_orders SET status = 'REPORT_PUBLISHED', version = version + 1, updated_at = now() WHERE id = $1`, [o.id]);
      await tx.query(`UPDATE lab_order_items SET status = 'REPORTED' WHERE order_id = $1`, [o.id]);
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: this.staffName(actor), action: amendment ? 'AMEND' : 'SIGN', resourceType: 'LAB_REPORT', resourceId: reportId, patientId: o.patient_id, purpose: 'TREATMENT', changes: amendment?.changed.slice(0, 40) ?? null });
      const data: LabReportPublished = {
        orderId: o.id, orderNo: o.order_no, reportId, version, amended: !!amendment, documentId, patientId: o.patient_id, accountPersonId: o.account_person_id,
        patientName: o.patient_name, patientMrn: o.patient_mrn, abnormalCount: abnormal, criticalCount: critical,
        orderedByUserId: o.ordered_by_doctor_id ? o.booked_by : null, orderedByName: o.ordered_by_name,
      };
      await addToOutbox(tx, Topics.diagnostics, o.id, envelope(EventTypes.labReportPublished, data, { tenantId: this.tid(), subject: reportId }));
      return { reportId, version, documentId, verifyCode, abnormal, critical };
    });
  }

  /** The PDF: lab staff, the patient's account, or a doctor with access (treating/consent). Never before verification. */
  async pdf(actor: Actor, orderId: string, labStaff: boolean) {
    const c = await this.db.current();
    const o = await this.lab.row(c, orderId);
    if (!o) throw notFound('lab order');
    if (actor.kind === 'patient') { if (o.account_person_id !== actor.id) throw notFound('lab order'); }
    else if (!labStaff) {
      const a = await this.care.check(actor.id, o.patient_id);
      if (!a.allowed) throw notFound('lab order');
    }
    const { rows } = await c.query('SELECT * FROM lab_reports WHERE order_id = $1 AND superseded_by IS NULL ORDER BY version DESC LIMIT 1', [orderId]);
    if (!rows[0]) throw notFound('report');
    if (actor.kind === 'staff') await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: this.staffName(actor), action: 'EXPORT', resourceType: 'LAB_REPORT', resourceId: rows[0].id, patientId: o.patient_id, purpose: 'TREATMENT' });
    return { pdf: rows[0].pdf as Buffer, name: `${o.order_no}-v${rows[0].version}.pdf` };
  }

  /** Public check behind the QR code: genuine, which version, still current — no results, no full name. */
  async verifyCode(code: string) {
    const c = await this.db.current();
    const { rows } = await c.query(`SELECT r.*, o.order_no, o.patient_name, o.collected_at FROM lab_reports r JOIN lab_orders o ON o.id = r.order_id WHERE r.verify_code = upper($1)`, [code]);
    const r = rows[0];
    if (!r) throw notFound('report');
    const initials = String(r.patient_name).split(/\s+/).filter(Boolean).map((p: string) => `${p[0]}.`).join(' ');
    return { valid: true, hospital: TenantContext.require().name, orderNo: r.order_no, patient: initials, version: r.version, verifiedBy: r.verified_by_name, verifiedAt: r.verified_at, current: !r.superseded_by, sha256: r.sha256 };
  }

  /** Doctor: their unacknowledged critical values (values shown in the app); lab: those of self-booked tests. */
  async alerts(actor: Actor, labStaff: boolean) {
    const c = await this.db.current();
    const { rows } = await c.query(
      `SELECT a.*, r.parameter, r.value, r.unit, r.ref_low, r.ref_high, r.flag, i.test_name, o.order_no, o.patient_id, o.patient_name, o.patient_mrn
       FROM critical_alerts a JOIN lab_results r ON r.id = a.result_id JOIN lab_order_items i ON i.id = r.item_id JOIN lab_orders o ON o.id = a.order_id
       WHERE ${labStaff ? 'a.notify_user_id IS NULL' : 'a.notify_user_id = $1'} AND (a.acknowledged_at IS NULL OR a.acknowledged_at > now() - interval '7 days')
       ORDER BY a.acknowledged_at NULLS FIRST, a.created_at DESC LIMIT 100`, labStaff ? [] : [actor.id]);
    for (const p of new Set(rows.map((r) => r.patient_id))) {
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: this.staffName(actor), action: 'READ', resourceType: 'CRITICAL_ALERTS', patientId: p, purpose: 'TREATMENT' });
    }
    return rows.map((r) => ({
      id: r.id, orderId: r.order_id, orderNo: r.order_no, patient: { id: r.patient_id, name: r.patient_name, mrn: r.patient_mrn },
      test: r.test_name, parameter: r.parameter, value: r.value, unit: r.unit, refLow: r.ref_low == null ? null : Number(r.ref_low), refHigh: r.ref_high == null ? null : Number(r.ref_high),
      flag: r.flag, createdAt: r.created_at, acknowledgedAt: r.acknowledged_at, acknowledgedBy: r.acknowledged_by_name,
    }));
  }

  async acknowledge(actor: Actor, alertId: string, labStaff: boolean) {
    await this.loadName(actor);
    return this.db.tx(async (c) => {
      const { rows } = await c.query('SELECT a.*, o.patient_id FROM critical_alerts a JOIN lab_orders o ON o.id = a.order_id WHERE a.id = $1 FOR UPDATE OF a', [alertId]);
      const a = rows[0];
      if (!a || (a.notify_user_id ? a.notify_user_id !== actor.id : !labStaff)) throw notFound('alert');
      if (!a.acknowledged_at) {
        await c.query('UPDATE critical_alerts SET acknowledged_at = now(), acknowledged_by = $2, acknowledged_by_name = $3 WHERE id = $1', [alertId, actor.id, this.staffName(actor)]);
        await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: this.staffName(actor), action: 'UPDATE', resourceType: 'CRITICAL_ALERT', resourceId: alertId, patientId: a.patient_id, purpose: 'TREATMENT', changes: ['acknowledged'] });
      }
      return { acknowledged: true };
    });
  }

  /** Doctor: tests they ordered (last 90 days), newest first, with the report and flag counts once verified. */
  async ordered(actor: Actor) {
    if (actor.kind !== 'staff') throw forbidden('DOCTORS_ONLY', 'doctors only');
    const c = await this.db.current();
    const { rows } = await c.query(
      `SELECT o.id, o.order_no, o.status, o.patient_id, o.patient_name, o.patient_mrn, o.created_at, o.slot_at,
              (SELECT row_to_json(x) FROM (SELECT version, document_id, abnormal_count, critical_count, verified_at FROM lab_reports WHERE order_id = o.id AND superseded_by IS NULL ORDER BY version DESC LIMIT 1) x) AS report,
              (SELECT string_agg(test_name, ', ' ORDER BY test_name) FROM lab_order_items WHERE order_id = o.id) AS tests
       FROM lab_orders o WHERE o.booked_by = $1 AND o.ordered_by_doctor_id IS NOT NULL AND o.created_at > now() - interval '90 days' ORDER BY o.created_at DESC LIMIT 100`, [actor.id]);
    return rows.map((r) => ({ id: r.id, orderNo: r.order_no, status: r.status, patient: { id: r.patient_id, name: r.patient_name, mrn: r.patient_mrn }, tests: r.tests, createdAt: r.created_at, slotAt: r.slot_at, report: r.report }));
  }

  /** Doctor: results of an order they can see (treating/consent) once verified — values with flags. */
  async resultsForDoctor(actor: Actor, orderId: string) {
    const c = await this.db.current();
    const o = await this.lab.row(c, orderId);
    if (!o) throw notFound('lab order');
    const a = await this.care.check(actor.id, o.patient_id);
    if (!a.allowed) throw notFound('lab order');
    await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: a.doctorName, action: 'READ', resourceType: 'LAB_RESULTS', resourceId: orderId, patientId: o.patient_id, purpose: a.purpose as any });
    const s = await this.sheet(c, orderId);
    return o.status === 'REPORT_PUBLISHED' ? s : { ...s, tests: s.tests.map((t) => ({ ...t, parameters: t.parameters.map((p) => (p.critical ? p : { ...p, value: null, flag: null })) })) };
  }

  /** Patient: their results, only after verification. */
  async resultsForPatient(actor: Actor, orderId: string) {
    const c = await this.db.current();
    const o = await this.lab.row(c, orderId);
    if (!o || o.account_person_id !== actor.id) throw notFound('lab order');
    if (o.status !== 'REPORT_PUBLISHED') throw new DomainError(409, 'NOT_READY', 'results are shown once the pathologist has verified the report');
    return this.sheet(c, orderId);
  }

  /** Job: orders past their promised turnaround (from first collection) are flagged once. */
  async markOverdue(c: Queryable) {
    const { rows } = await c.query(`UPDATE lab_orders SET tat_breached_at = now() WHERE due_at < now() AND tat_breached_at IS NULL AND status IN ('SAMPLE_COLLECTED','IN_LAB','RESULTS_ENTERED') RETURNING id`);
    for (const r of rows) await this.lab.emit(c, EventTypes.labTatBreached, await this.lab.row(c, r.id));
    return rows.length;
  }
}
