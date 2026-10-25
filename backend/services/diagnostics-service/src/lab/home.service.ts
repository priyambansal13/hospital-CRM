import { Injectable } from '@nestjs/common';
import { EventTypes, type HomeVisitChanged, StaffJoined, Topics } from '@mc/contracts';
import { conflict, DomainError, notFound } from '@mc/nest-common';
import { type Actor, addToOutbox, envelope, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { AuditClient } from './clients.js';
import { LabService } from './lab.service.js';

const money = (v: unknown) => Number(v ?? 0);
const todayIn = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const localTime = (at: Date | string, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
/** what a phlebotomist may do next, by visit status */
const NEXT: Record<string, string[]> = { start: ['ASSIGNED'], arrive: ['EN_ROUTE'], miss: ['ASSIGNED', 'EN_ROUTE', 'ARRIVED'], collect: ['ARRIVED'] };

/**
 * Home sample collection (module home_collection): pincodes served and fees, the dispatch board (assign a
 * phlebotomist), and the phlebotomist's day: on the way → arrived → scan each tube (after payment) → collected; the
 * lab's first scan of a tube is the hand-over. A missed visit sends the order back to the patient to pick a new time.
 */
@Injectable()
export class HomeService {
  constructor(private readonly db: TenantDbRouter, private readonly lab: LabService, private readonly audit: AuditClient) {}

  private tid() { return TenantContext.require().id; }

  // ---------- public ----------

  async check(pincode: string) {
    const a = await this.lab.homeArea(await this.db.current(), pincode);
    return a ? { serviceable: true, pincode, branch: { id: a.branch_id, name: a.branch_name }, area: a.area, fee: money(a.fee) } : { serviceable: false, pincode, branch: null, area: null, fee: null };
  }

  async slots(pincode: string, date: string) {
    const a = await this.lab.homeArea(await this.db.current(), pincode);
    if (!a) throw new DomainError(422, 'PINCODE_NOT_SERVED', `we do not collect samples at home in ${pincode} yet`);
    return { ...(await this.lab.slots(a.branch_id, date, 'HOME')), fee: money(a.fee), area: a.area };
  }

  // ---------- admin: areas and home times ----------

  async areas() {
    const { rows } = await this.db.query(`SELECT a.*, b.name AS branch_name FROM home_service_areas a JOIN branches b ON b.id = a.branch_id ORDER BY b.name, a.pincode`);
    return rows.map((a) => ({ id: a.id, pincode: a.pincode, area: a.area, fee: money(a.fee), active: a.active, branch: { id: a.branch_id, name: a.branch_name } }));
  }

  async upsertArea(v: { pincode: string; branchId: string; area: string | null; fee: number; active: boolean }) {
    const { rows: [b] } = await this.db.query('SELECT 1 FROM branches WHERE id = $1 AND active', [v.branchId]);
    if (!b) throw notFound('branch');
    await this.db.query(
      `INSERT INTO home_service_areas (id, branch_id, pincode, area, fee, active) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (pincode) DO UPDATE SET branch_id = $2, area = $4, fee = $5, active = $6, updated_at = now()`,
      [randomUUID(), v.branchId, v.pincode, v.area, v.fee, v.active]);
    return (await this.areas()).find((a) => a.pincode === v.pincode);
  }

  async homeWindows(branchId: string) {
    const { rows: [b] } = await this.db.query('SELECT 1 FROM branches WHERE id = $1', [branchId]);
    if (!b) throw notFound('branch');
    const { rows } = await this.db.query(`SELECT day_of_week, to_char(start_time, 'HH24:MI') AS start, to_char(end_time, 'HH24:MI') AS end, slot_minutes, capacity FROM collection_windows WHERE branch_id = $1 AND kind = 'HOME' ORDER BY day_of_week, start_time`, [branchId]);
    return rows.map((w) => ({ day: w.day_of_week, start: w.start, end: w.end, slotMinutes: w.slot_minutes, capacity: w.capacity }));
  }

  async setHomeWindows(branchId: string, windows: { day: number; start: string; end: string; slotMinutes: number; capacity: number }[]) {
    await this.db.tx(async (c) => {
      const { rows: [b] } = await c.query('SELECT 1 FROM branches WHERE id = $1', [branchId]);
      if (!b) throw notFound('branch');
      await c.query(`DELETE FROM collection_windows WHERE branch_id = $1 AND kind = 'HOME'`, [branchId]);
      for (const w of windows) {
        if (w.end <= w.start) throw new DomainError(422, 'INVALID_WINDOW', `${w.start}–${w.end}: the end must be after the start`);
        await c.query(`INSERT INTO collection_windows (id, branch_id, kind, day_of_week, start_time, end_time, slot_minutes, capacity) VALUES ($1,$2,'HOME',$3,$4,$5,$6,$7)`,
          [randomUUID(), branchId, w.day, w.start, w.end, w.slotMinutes, w.capacity]);
      }
    });
    return this.homeWindows(branchId);
  }

  // ---------- phlebotomists (read model from iam) ----------

  async onStaffJoined(c: Queryable, data: unknown) {
    const s = StaffJoined.parse(data);
    if (!s.initialRoles.includes('PHLEBOTOMIST')) return;
    await c.query(`INSERT INTO phlebotomists (user_id, name, email) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET name = $2, email = $3, active = true`, [s.userId, s.name, s.email]);
  }

  // ---------- dispatch board ----------

  private async visitRows(c: Queryable, where: string, params: unknown[], lock = false) {
    const { rows } = await c.query(
      `SELECT v.*, o.order_no, o.status AS order_status, o.payment_status, o.total, o.patient_id, o.patient_name, o.patient_mrn, o.patient_dob, o.patient_gender, o.home_address, b.name AS branch_name, b.timezone
       FROM home_visits v JOIN lab_orders o ON o.id = v.order_id JOIN branches b ON b.id = v.branch_id
       WHERE ${where} ORDER BY v.slot_at, o.order_no${lock ? ' FOR UPDATE OF v' : ''}`, params);
    return rows;
  }

  private async visitDto(c: Queryable, v: any, detail = false) {
    const order = detail ? await this.lab.dto(c, await this.lab.row(c, v.order_id)) : null;
    const { rows: log } = detail ? await c.query('SELECT status, by_name, note, at FROM home_visit_log WHERE visit_id = $1 ORDER BY at', [v.id]) : { rows: [] };
    return {
      id: v.id, status: v.status, orderId: v.order_id, orderNo: v.order_no, orderStatus: v.order_status, paymentStatus: v.payment_status, total: money(v.total),
      slotAt: v.slot_at, localTime: localTime(v.slot_at, v.timezone), localDate: new Intl.DateTimeFormat('en-CA', { timeZone: v.timezone }).format(new Date(v.slot_at)),
      branch: { id: v.branch_id, name: v.branch_name }, patient: { id: v.patient_id, name: v.patient_name, mrn: v.patient_mrn, gender: v.patient_gender },
      address: v.home_address, phlebotomist: v.phlebotomist_id ? { id: v.phlebotomist_id, name: v.phlebotomist_name } : null,
      attempts: v.attempts, missedReason: v.missed_reason,
      ...(detail ? { order, log: log.map((l) => ({ status: l.status, by: l.by_name, note: l.note, at: l.at })) } : {}),
    };
  }

  /** Home collections at a branch on a day (booked ones; unpaid online holds are not shown), and who can be sent. */
  async board(actor: Actor, branchId: string, date: string | undefined) {
    const c = await this.db.current();
    const { rows: [b] } = await c.query('SELECT * FROM branches WHERE id = $1', [branchId]);
    if (!b) throw notFound('branch');
    const day = date ?? todayIn(b.timezone);
    const rows = await this.visitRows(c, `v.branch_id = $1 AND v.local_date = $2::date AND v.status <> 'CANCELLED' AND o.status NOT IN ('PENDING_PAYMENT','EXPIRED','CANCELLED')`, [branchId, day]);
    const { rows: people } = await c.query('SELECT user_id, name FROM phlebotomists WHERE active ORDER BY name');
    await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: actor.email ?? null, action: 'READ', resourceType: 'HOME_VISITS', purpose: 'TREATMENT' });
    const visits = await Promise.all(rows.map((v) => this.visitDto(c, v)));
    const count = (...s: string[]) => visits.filter((v) => s.includes(v.status)).length;
    return {
      branch: { id: b.id, name: b.name }, date: day, visits,
      totals: { unassigned: count('UNASSIGNED'), assigned: count('ASSIGNED'), out: count('EN_ROUTE', 'ARRIVED'), collected: count('COLLECTED', 'HANDED_OVER'), missed: count('MISSED') },
      phlebotomists: people.map((p) => ({ id: p.user_id, name: p.name, visits: visits.filter((v) => v.phlebotomist?.id === p.user_id && v.status !== 'MISSED').length })),
    };
  }

  private async lockVisit(c: Queryable, visitId: string) {
    const rows = await this.visitRows(c, 'v.id = $1', [visitId], true);
    if (!rows[0]) throw notFound('home visit');
    return rows[0];
  }

  /** Send a phlebotomist (or another one, until they have set off). One home at a time per phlebotomist. */
  async assign(actor: Actor, visitId: string, phlebotomistId: string) {
    return this.db.tx(async (c) => {
      const v = await this.lockVisit(c, visitId);
      if (!['UNASSIGNED', 'ASSIGNED'].includes(v.status)) throw conflict('INVALID_STATE_TRANSITION', `the visit is ${v.status.toLowerCase().replace('_', ' ')}`);
      if (v.order_status !== 'BOOKED') throw conflict('INVALID_STATE_TRANSITION', v.order_status === 'PENDING_PAYMENT' ? 'the patient has not paid yet' : `the order is ${v.order_status.toLowerCase().replace('_', ' ')}`);
      const { rows: [p] } = await c.query('SELECT * FROM phlebotomists WHERE user_id = $1 AND active', [phlebotomistId]);
      if (!p) throw new DomainError(422, 'NOT_A_PHLEBOTOMIST', 'pick one of the phlebotomists');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`phleb:${p.user_id}:${new Date(v.slot_at).toISOString()}`]);
      const { rows: busy } = await c.query(`SELECT 1 FROM home_visits WHERE phlebotomist_id = $1 AND slot_at = $2 AND id <> $3 AND status IN ('ASSIGNED','EN_ROUTE','ARRIVED')`, [p.user_id, v.slot_at, v.id]);
      if (busy[0]) throw conflict('PHLEBOTOMIST_BUSY', `${p.name} already has a visit at ${localTime(v.slot_at, v.timezone)}`);
      await c.query(`UPDATE home_visits SET status = 'ASSIGNED', phlebotomist_id = $2, phlebotomist_name = $3, version = version + 1, updated_at = now() WHERE id = $1`, [v.id, p.user_id, p.name]);
      await this.lab.visitLog(c, v.id, 'ASSIGNED', actor, `assigned to ${p.name}`);
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: actor.email ?? null, action: 'UPDATE', resourceType: 'HOME_VISIT', resourceId: v.id, patientId: v.patient_id, purpose: 'TREATMENT', changes: ['phlebotomist'] });
      const u = await this.lockVisit(c, v.id);
      await this.emit(c, EventTypes.homeVisitAssigned, u);
      return this.visitDto(c, u);
    });
  }

  // ---------- the phlebotomist's day ----------

  /** My visits for a day (today by default), in visit order, with address, phone, preparation and tube labels. */
  async mine(actor: Actor, date: string | undefined) {
    const c = await this.db.current();
    const day = date ?? todayIn('Asia/Kolkata');
    const rows = await this.visitRows(c, `v.phlebotomist_id = $1 AND v.local_date = $2::date AND v.status <> 'CANCELLED'`, [actor.id, day]);
    for (const p of new Set(rows.map((r) => r.patient_id))) {
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: actor.email ?? null, action: 'READ', resourceType: 'HOME_VISIT', patientId: p, purpose: 'TREATMENT' });
    }
    return { date: day, visits: await Promise.all(rows.map((v) => this.visitDto(c, v, true))) };
  }

  /** One of my visits (404 for anyone else's). */
  private async myVisit(c: Queryable, actor: Actor, visitId: string, step: keyof typeof NEXT) {
    const v = await this.lockVisit(c, visitId);
    if (v.phlebotomist_id !== actor.id) throw notFound('home visit');
    if (!NEXT[step].includes(v.status)) throw conflict('INVALID_STATE_TRANSITION', `the visit is ${v.status.toLowerCase().replace('_', ' ')}`);
    return v;
  }

  async start(actor: Actor, visitId: string) {
    return this.db.tx(async (c) => {
      const v = await this.myVisit(c, actor, visitId, 'start');
      if (new Intl.DateTimeFormat('en-CA', { timeZone: v.timezone }).format(new Date(v.slot_at)) !== todayIn(v.timezone)) throw new DomainError(422, 'NOT_TODAY', 'this visit is on another day');
      return this.step(c, actor, v, 'EN_ROUTE', EventTypes.homeVisitEnRoute);
    });
  }

  async arrive(actor: Actor, visitId: string) {
    return this.db.tx(async (c) => this.step(c, actor, await this.myVisit(c, actor, visitId, 'arrive'), 'ARRIVED', null));
  }

  /** Patient not at home / refused / no sample: the order goes back to the patient to pick another home visit. */
  async miss(actor: Actor, visitId: string, reason: string) {
    return this.db.tx(async (c) => {
      const v = await this.myVisit(c, actor, visitId, 'miss');
      const { rows: collected } = await c.query(`SELECT 1 FROM samples WHERE order_id = $1 AND status = 'COLLECTED'`, [v.order_id]);
      if (collected[0]) throw conflict('PARTLY_COLLECTED', 'some tubes are already collected; collect the rest or take them to the lab');
      await c.query(`UPDATE home_visits SET missed_reason = $2 WHERE id = $1`, [v.id, reason]);
      await c.query(`UPDATE lab_orders SET status = 'AWAITING_BOOKING', version = version + 1, updated_at = now() WHERE id = $1`, [v.order_id]);
      return this.step(c, actor, { ...v, missed_reason: reason }, 'MISSED', EventTypes.homeVisitMissed, reason);
    });
  }

  /** Scan a tube at the patient's home (paid first); the last one completes the visit. */
  async collect(actor: Actor, visitId: string, barcode: string) {
    return this.db.tx(async (c) => {
      const v = await this.myVisit(c, actor, visitId, 'collect');
      const s = await this.lab.sampleByBarcode(c, barcode);
      if (s.order_id !== v.order_id) throw new DomainError(422, 'WRONG_PATIENT', `tube ${s.barcode} is not for ${v.patient_name}`);
      const r = await this.lab.collectSample(c, actor, s);
      let visit = await this.visitDto(c, await this.lockVisit(c, v.id));
      if (!r.pendingSamples) visit = await this.step(c, actor, await this.lockVisit(c, v.id), 'COLLECTED', EventTypes.homeVisitCollected);
      return { barcode: r.barcode, pendingSamples: r.pendingSamples, visit };
    });
  }

  private async step(c: Queryable, actor: Actor, v: any, to: string, event: string | null, note: string | null = null) {
    await c.query(`UPDATE home_visits SET status = $2, version = version + 1, updated_at = now() WHERE id = $1`, [v.id, to]);
    await this.lab.visitLog(c, v.id, to, actor, note, v.phlebotomist_name);
    const u = await this.lockVisit(c, v.id);
    if (event) await this.emit(c, event, u);
    return this.visitDto(c, u, true);
  }

  private async emit(c: Queryable, type: string, v: any) {
    const data: HomeVisitChanged = {
      visitId: v.id, orderId: v.order_id, orderNo: v.order_no, status: v.status, patientId: v.patient_id, accountPersonId: (await this.lab.row(c, v.order_id)).account_person_id,
      patientName: v.patient_name, branchName: v.branch_name, slotAt: new Date(v.slot_at).toISOString(),
      localDate: new Intl.DateTimeFormat('en-CA', { timeZone: v.timezone }).format(new Date(v.slot_at)), localTime: localTime(v.slot_at, v.timezone),
      pincode: v.home_address?.pincode ?? '', phlebotomistUserId: v.phlebotomist_id, phlebotomistName: v.phlebotomist_name, reason: v.missed_reason,
    };
    await addToOutbox(c, Topics.diagnostics, v.order_id, envelope(type, data, { tenantId: this.tid(), subject: v.id }));
  }
}
