import { Injectable } from '@nestjs/common';
import { EventTypes, type LabOrderChanged, Topics } from '@mc/contracts';
import { conflict, DomainError, forbidden, notFound } from '@mc/nest-common';
import { assertInBranch, branchesFor, EntitlementsClient, inBranch } from '@mc/entitlements-sdk';
import { type Actor, addToOutbox, envelope, type Queryable, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { randomUUID } from 'node:crypto';
import { AuditClient, BillingClient, CareAccessClient, type Patient, PatientsClient } from './clients.js';
import { DEFAULT_HOME_WINDOWS, DEFAULT_PACKAGES, DEFAULT_TESTS, DEFAULT_WINDOWS } from './default-catalog.js';

export const LAB_POLICY = {
  holdMinutes: Number(process.env.LAB_PAYMENT_HOLD_MINUTES ?? 15),
  minLeadMinutes: Number(process.env.LAB_MIN_LEAD_MINUTES ?? 30),
  /** a phlebotomist needs time to be assigned and travel */
  minHomeLeadMinutes: Number(process.env.LAB_MIN_HOME_LEAD_MINUTES ?? 120),
  maxAdvanceDays: Number(process.env.LAB_MAX_ADVANCE_DAYS ?? 30),
};
/** statuses that take up a place in a collection slot */
const OCCUPYING = `('PENDING_PAYMENT','BOOKED','SAMPLE_COLLECTED','IN_LAB','SAMPLE_REJECTED')`;
const HAS_MONEY = ['PAID', 'PARTIALLY_REFUNDED'];
const money = (v: unknown) => Number(v ?? 0);

export interface ItemRef { testId?: string; packageId?: string }
export type Kind = 'LAB' | 'HOME';
export interface HomeAddress { line1: string; line2?: string | null; landmark?: string | null; city?: string | null; pincode: string; phone: string }
/** Where the samples are taken: at a branch, or at the patient's address (branch = the one serving the pincode). */
export type Collection = { type: 'AT_LAB'; branchId: string } | { type: 'HOME'; address: HomeAddress };
const kindOf = (collectionType: string): Kind => (collectionType === 'HOME' ? 'HOME' : 'LAB');

/** Combined preparation for an order: the longest fast + every other instruction once. */
export function preparationFor(tests: { preparation: string | null; fasting_hours: number | null }[]): string | null {
  const fast = Math.max(0, ...tests.map((t) => t.fasting_hours ?? 0));
  const other = [...new Set(tests.filter((t) => t.preparation && !t.fasting_hours).map((t) => t.preparation!))];
  const parts = [fast ? `Fast for ${fast} hours before the test (water is fine)` : null, ...other].filter(Boolean);
  return parts.length ? parts.join('. ') : null;
}

/** Staff booking lab tests for a patient (D-3). */
export const STAFF_BOOK = 'lab_order:create:branch';
/** staff may book the collection time that started up to this long ago (the patient is at the counter) */
const STAFF_LEAD_MINUTES = -30;

@Injectable()
export class LabService {
  constructor(
    private readonly db: TenantDbRouter,
    private readonly patients: PatientsClient,
    private readonly care: CareAccessClient,
    private readonly audit: AuditClient,
    private readonly billing: BillingClient,
    private readonly entitlements: EntitlementsClient,
  ) {}

  private tid() { return TenantContext.require().id; }
  async caps(actor: Actor) { return this.entitlements.capabilities(this.tid(), actor); }

  /** Lab staff act on orders of their own branches only (review B-1); others answer "not found". */
  async atBranch(actor: Actor, permission: string, branchId: string | null, what = 'lab order') {
    assertInBranch(await this.caps(actor), permission, branchId, what);
  }

  /** The branches a lab permission covers (null = every branch). */
  async branchesOf(actor: Actor, permission: string) {
    return branchesFor(await this.caps(actor), permission);
  }

  // ---------- seeding ----------

  async seedCatalog(c: Queryable) {
    for (const t of DEFAULT_TESTS) {
      await c.query(`INSERT INTO lab_tests (id, code, loinc_code, name, aliases, category, sample_type, container, preparation, fasting_hours, turnaround_hours, price, reference_ranges)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (code) DO NOTHING`,
        [randomUUID(), t.code, t.loinc ?? null, t.name, t.aliases ?? [], t.category, t.sampleType, t.container ?? null, t.preparation ?? null, t.fastingHours ?? null, t.turnaroundHours, t.price, JSON.stringify(t.ranges)]);
    }
    for (const p of DEFAULT_PACKAGES) {
      const { rows } = await c.query(`INSERT INTO lab_packages (id, code, name, description, price) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (code) DO NOTHING RETURNING id`, [randomUUID(), p.code, p.name, p.description, p.price]);
      if (rows[0]) await c.query(`INSERT INTO package_tests (package_id, test_id) SELECT $1, id FROM lab_tests WHERE code = ANY($2) ON CONFLICT DO NOTHING`, [rows[0].id, p.tests]);
    }
  }

  /** Default lab and home collection times for a branch (each kind only if the branch has none of that kind yet). */
  async ensureWindows(c: Queryable, branchId: string) {
    for (const [kind, defaults, slot, cap] of [['LAB', DEFAULT_WINDOWS, 15, 3], ['HOME', DEFAULT_HOME_WINDOWS, 30, 2]] as const) {
      const { rows } = await c.query('SELECT 1 FROM collection_windows WHERE branch_id = $1 AND kind = $2 LIMIT 1', [branchId, kind]);
      if (rows[0]) continue;
      for (const w of defaults) {
        await c.query(`INSERT INTO collection_windows (id, branch_id, kind, day_of_week, start_time, end_time, slot_minutes, capacity) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [randomUUID(), branchId, kind, w.day, w.start, w.end, slot, cap]);
      }
    }
  }

  /** Branches that existed before home collection get their home times too. */
  async ensureAllWindows(c: Queryable) {
    const { rows } = await c.query('SELECT id FROM branches');
    for (const b of rows) await this.ensureWindows(c, b.id);
  }

  // ---------- catalog & slots (public) ----------

  async catalog(q: string | undefined) {
    const c = await this.db.current();
    const term = q?.trim().toLowerCase().replace(/[%_\\]/g, '') ?? '';
    const { rows: tests } = await c.query(
      `SELECT * FROM lab_tests WHERE active AND ($1 = '' OR lower(name) LIKE '%' || $1 || '%' OR lower(code) = $1 OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) LIKE '%' || $1 || '%'))
       ORDER BY category, name`, [term]);
    const { rows: pkgs } = await c.query(
      `SELECT p.*, coalesce(json_agg(json_build_object('code', t.code, 'name', t.name, 'price', t.price, 'preparation', t.preparation, 'fastingHours', t.fasting_hours) ORDER BY t.name) FILTER (WHERE t.id IS NOT NULL), '[]') AS tests
       FROM lab_packages p LEFT JOIN package_tests pt ON pt.package_id = p.id LEFT JOIN lab_tests t ON t.id = pt.test_id AND t.active
       WHERE p.active GROUP BY p.id ORDER BY p.price`);
    return {
      packages: term ? pkgs.filter((p) => p.name.toLowerCase().includes(term) || p.tests.some((t: any) => t.name.toLowerCase().includes(term))).map(toPackage) : pkgs.map(toPackage),
      tests: tests.map(toTest),
    };
  }

  /** Free collection times at a branch on a date (local), with how many places are left (lab visits or home visits). */
  /** `leadMinutes`: how soon a time may be; staff booking a patient who is at the counter use the slot running now. */
  async slots(branchId: string, date: string, kind: Kind = 'LAB', leadMinutes?: number) {
    const c = await this.db.current();
    const { rows: [b] } = await c.query('SELECT * FROM branches WHERE id = $1 AND active', [branchId]);
    if (!b) throw notFound('branch');
    const { rows } = await c.query(
      `WITH win AS (
         SELECT w.*, gs AS local_ts FROM collection_windows w,
           generate_series(($2::date + w.start_time)::timestamp, ($2::date + w.end_time - make_interval(mins => w.slot_minutes))::timestamp, make_interval(mins => w.slot_minutes)) gs
         WHERE w.branch_id = $1 AND w.kind = $5 AND w.day_of_week = extract(isodow FROM $2::date))
       SELECT to_char(local_ts, 'HH24:MI') AS local_time, (local_ts AT TIME ZONE $3) AS slot_at, capacity,
              (SELECT count(*) FROM lab_orders o WHERE o.branch_id = $1 AND o.collection_type = $6 AND o.slot_at = (local_ts AT TIME ZONE $3) AND o.status IN ${OCCUPYING})::int AS taken
       FROM win WHERE (local_ts AT TIME ZONE $3) > now() + make_interval(mins => $4) ORDER BY local_ts`,
      [branchId, date, b.timezone, leadMinutes ?? (kind === 'HOME' ? LAB_POLICY.minHomeLeadMinutes : LAB_POLICY.minLeadMinutes), kind, kind === 'HOME' ? 'HOME' : 'AT_LAB']);
    return { branch: { id: b.id, name: b.name }, date, slots: rows.map((r) => ({ slotAt: r.slot_at, localTime: r.local_time, left: Math.max(0, r.capacity - r.taken) })) };
  }

  // ---------- ordering ----------

  /** Expand chosen packages/tests into billable lines and the tests to run (a test already in a package is not charged twice). */
  private async expand(c: Queryable, items: ItemRef[]) {
    const pkgIds = items.map((i) => i.packageId).filter(Boolean) as string[];
    const testIds = items.map((i) => i.testId).filter(Boolean) as string[];
    const { rows: pkgs } = await c.query(`SELECT * FROM lab_packages WHERE id = ANY($1) AND active`, [pkgIds]);
    if (pkgs.length !== new Set(pkgIds).size) throw new DomainError(422, 'UNKNOWN_PACKAGE', 'a package is not available');
    const { rows: pkgTests } = await c.query(`SELECT pt.package_id, t.* FROM package_tests pt JOIN lab_tests t ON t.id = pt.test_id WHERE pt.package_id = ANY($1) AND t.active`, [pkgIds]);
    const { rows: tests } = await c.query(`SELECT * FROM lab_tests WHERE id = ANY($1) AND active`, [testIds]);
    if (tests.length !== new Set(testIds).size) throw new DomainError(422, 'UNKNOWN_TEST', 'a test is not available');
    const lines: { id: string; kind: 'TEST' | 'PACKAGE'; refId: string; code: string; name: string; price: number; tests: any[] }[] = [];
    const seen = new Set<string>();
    for (const p of pkgs) {
      const ts = pkgTests.filter((t) => t.package_id === p.id && !seen.has(t.id));
      ts.forEach((t) => seen.add(t.id));
      lines.push({ id: randomUUID(), kind: 'PACKAGE', refId: p.id, code: p.code, name: p.name, price: money(p.price), tests: ts });
    }
    for (const t of tests) {
      if (seen.has(t.id)) continue; // already in a package
      seen.add(t.id);
      lines.push({ id: randomUUID(), kind: 'TEST', refId: t.id, code: t.code, name: t.name, price: money(t.price), tests: [t] });
    }
    if (!lines.length) throw new DomainError(422, 'NOTHING_ORDERED', 'choose at least one test or package');
    return { lines, total: Math.round(lines.reduce((s, l) => s + l.price, 0) * 100) / 100, tests: lines.flatMap((l) => l.tests) };
  }

  private async insertOrder(c: Queryable, p: Patient, v: { orderedBy?: { doctorId: string | null; name: string | null }; encounterId?: string | null; note?: string | null; status: string; bookedBy: string }, x: Awaited<ReturnType<LabService['expand']>>) {
    const id = randomUUID();
    const { rows: [{ no }] } = await c.query(`SELECT 'LAB-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('lab_order_seq')::text, 6, '0') AS no`);
    await c.query(
      `INSERT INTO lab_orders (id, order_no, patient_id, patient_name, patient_mrn, patient_dob, patient_gender, account_person_id, ordered_by_doctor_id, ordered_by_name, encounter_id, status, total, note, booked_by, payment_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id, no, p.id, p.fullName, p.mrn, p.dob, p.gender, p.accountPersonId, v.orderedBy?.doctorId ?? null, v.orderedBy?.name ?? null, v.encounterId ?? null, v.status, x.total, v.note ?? null, v.bookedBy, x.total > 0 ? 'UNPAID' : 'NOT_DUE']);
    for (const l of x.lines) {
      await c.query('INSERT INTO lab_order_lines (id, order_id, kind, ref_id, code, name, price) VALUES ($1,$2,$3,$4,$5,$6,$7)', [l.id, id, l.kind, l.refId, l.code, l.name, l.price]);
      for (const t of l.tests) {
        await c.query('INSERT INTO lab_order_items (id, order_id, line_id, test_id, test_code, test_name, sample_type) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), id, l.id, t.id, t.code, t.name, t.sample_type]);
      }
    }
    return id;
  }

  /** The branch serving a pincode for home collection, with the visit fee (null: not served). */
  async homeArea(c: Queryable, pincode: string) {
    const { rows } = await c.query(
      `SELECT a.*, b.name AS branch_name FROM home_service_areas a JOIN branches b ON b.id = a.branch_id AND b.active WHERE a.pincode = $1 AND a.active`, [pincode.trim()]);
    return rows[0] ?? null;
  }

  /**
   * Put an order in a collection slot (capacity checked under a per-slot lock) and create its sample labels. Home:
   * the pincode decides the branch, every test must be one that can be collected at home, the visit fee is added
   * once, and the visit is (re)created unassigned.
   */
  private async schedule(c: Queryable, actor: Actor, orderId: string, collection: Collection, slotAt: string, paymentMode: 'ONLINE' | 'AT_CLINIC', opts: { leadMinutes?: number } = {}) {
    const home = collection.type === 'HOME' ? collection : null;
    const { rows: [visit] } = await c.query('SELECT * FROM home_visits WHERE order_id = $1', [orderId]);
    if (visit && !home) throw conflict('HOME_ORDER', 'this order is collected at home; pick another home visit time (or cancel it)');
    let branchId: string;
    let fee = 0;
    if (home) {
      if (!(await this.caps(actor)).modules.includes('home_collection')) throw new DomainError(422, 'HOME_COLLECTION_OFF', 'this hospital does not offer home collection');
      const area = await this.homeArea(c, home.address.pincode);
      if (!area) throw new DomainError(422, 'PINCODE_NOT_SERVED', `we do not collect samples at home in ${home.address.pincode} yet; please visit the lab`);
      branchId = area.branch_id;
      fee = money(area.fee);
      const { rows: [{ n }] } = await c.query(`SELECT count(*)::int AS n FROM lab_order_items WHERE order_id = $1 AND sample_type = 'NONE'`, [orderId]);
      if (n) throw new DomainError(422, 'NOT_HOME_COLLECTABLE', 'some of these tests (scans, ECG) can only be done at the lab');
    } else {
      branchId = (collection as Extract<Collection, { type: 'AT_LAB' }>).branchId;
    }
    const kind: Kind = home ? 'HOME' : 'LAB';
    const { rows: [b] } = await c.query('SELECT * FROM branches WHERE id = $1 AND active', [branchId]);
    if (!b) throw notFound('branch');
    const slot = new Date(slotAt);
    const lead = opts.leadMinutes ?? (home ? LAB_POLICY.minHomeLeadMinutes : LAB_POLICY.minLeadMinutes);
    if (slot.getTime() < Date.now() + lead * 60_000) throw new DomainError(422, 'SLOT_TOO_SOON', 'pick a later time');
    // the hospital's setting, within its plan's bounds (default 30 days)
    const maxDays = await this.entitlements.setting(this.tid(), 'diagnostics.max_advance_days', LAB_POLICY.maxAdvanceDays);
    if (slot.getTime() > Date.now() + maxDays * 86_400_000) throw new DomainError(422, 'SLOT_TOO_FAR', `book at most ${maxDays} days ahead`);
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`labslot:${branchId}:${kind}:${slot.toISOString()}`]);
    const { rows: [w] } = await c.query(
      `SELECT w.capacity, (SELECT count(*) FROM lab_orders o WHERE o.branch_id = $1 AND o.collection_type = $5 AND o.slot_at = $2 AND o.status IN ${OCCUPYING} AND o.id <> $6)::int AS taken
       FROM collection_windows w, LATERAL (SELECT ($2::timestamptz AT TIME ZONE $3) AS local_ts) l
       WHERE w.branch_id = $1 AND w.kind = $4 AND w.day_of_week = extract(isodow FROM l.local_ts)
         AND l.local_ts::time >= w.start_time AND l.local_ts::time < w.end_time
         AND extract(epoch FROM (l.local_ts::time - w.start_time))::int % (w.slot_minutes * 60) = 0
       LIMIT 1`, [branchId, slot.toISOString(), b.timezone, kind, home ? 'HOME' : 'AT_LAB', orderId]);
    if (!w) throw new DomainError(422, 'NOT_A_COLLECTION_TIME', home ? 'we do not visit homes at that time' : 'the lab does not collect samples at that time');
    if (w.taken >= w.capacity) throw conflict('SLOT_FULL', 'that time is full; please pick another');
    const { rows: [cur] } = await c.query('SELECT collection_type, payment_status, payment_mode FROM lab_orders WHERE id = $1', [orderId]);
    if (home) {
      const { rows: feeLine } = await c.query(`SELECT 1 FROM lab_order_lines WHERE order_id = $1 AND kind = 'HOME_VISIT'`, [orderId]);
      if (!feeLine[0] && fee > 0) {
        await c.query(`INSERT INTO lab_order_lines (id, order_id, kind, ref_id, code, name, price) VALUES ($1,$2,'HOME_VISIT',$3,'HOME','Home collection',$4)`, [randomUUID(), orderId, orderId, fee]);
        await c.query(`UPDATE lab_orders SET total = total + $2, payment_status = CASE WHEN payment_status = 'NOT_DUE' THEN 'UNPAID' ELSE payment_status END WHERE id = $1`, [orderId, fee]);
      }
    }
    const { rows: [o] } = await c.query('SELECT total, payment_status FROM lab_orders WHERE id = $1', [orderId]);
    const alreadyPaid = cur.payment_status === 'PAID' && o.payment_status === 'PAID';
    const online = paymentMode === 'ONLINE' && money(o.total) > 0 && !alreadyPaid;
    await c.query(
      `UPDATE lab_orders SET branch_id = $2, slot_at = $3, local_date = ($3::timestamptz AT TIME ZONE $4)::date, payment_mode = $5,
         status = $6, hold_expires_at = $7, collection_type = $8, home_address = $9, version = version + 1, updated_at = now() WHERE id = $1`,
      [orderId, branchId, slot.toISOString(), b.timezone, alreadyPaid ? cur.payment_mode ?? paymentMode : paymentMode, online ? 'PENDING_PAYMENT' : 'BOOKED',
        online ? new Date(Date.now() + LAB_POLICY.holdMinutes * 60_000) : null, home ? 'HOME' : 'AT_LAB', home ? JSON.stringify(home.address) : null]);
    if (home) {
      if (visit) {
        await c.query(`UPDATE home_visits SET branch_id = $2, slot_at = $3, local_date = ($3::timestamptz AT TIME ZONE $4)::date, status = 'UNASSIGNED', phlebotomist_id = NULL, phlebotomist_name = NULL,
                         missed_reason = NULL, attempts = attempts + 1, version = version + 1, updated_at = now() WHERE id = $1`, [visit.id, branchId, slot.toISOString(), b.timezone]);
        await this.visitLog(c, visit.id, 'UNASSIGNED', actor, 'rebooked');
      } else {
        const vid = randomUUID();
        await c.query(`INSERT INTO home_visits (id, order_id, branch_id, slot_at, local_date, status) VALUES ($1,$2,$3,$4,($4::timestamptz AT TIME ZONE $5)::date,'UNASSIGNED')`, [vid, orderId, branchId, slot.toISOString(), b.timezone]);
        await this.visitLog(c, vid, 'UNASSIGNED', actor, 'booked');
      }
    }
    await this.createSamples(c, orderId);
    return online;
  }

  async visitLog(c: Queryable, visitId: string, status: string, actor: Actor | null, note: string | null = null, byName: string | null = null) {
    await c.query('INSERT INTO home_visit_log (id, visit_id, status, by_user, by_name, note) VALUES ($1,$2,$3,$4,$5,$6)',
      [randomUUID(), visitId, status, actor?.id ?? null, byName ?? (actor?.kind === 'patient' ? 'patient' : actor?.email ?? null), note]);
  }

  private async createSamples(c: Queryable, orderId: string) {
    const { rows: existing } = await c.query(`SELECT 1 FROM samples WHERE order_id = $1 LIMIT 1`, [orderId]);
    if (existing[0]) return;
    const { rows } = await c.query(
      `SELECT DISTINCT t.sample_type, t.container FROM lab_order_items i JOIN lab_tests t ON t.id = i.test_id WHERE i.order_id = $1 AND t.sample_type <> 'NONE' ORDER BY 1, 2`, [orderId]);
    for (const r of rows) await this.newSample(c, orderId, r.sample_type, r.container, null);
  }

  private async newSample(c: Queryable, orderId: string, sampleType: string, container: string | null, replaces: string | null) {
    const { rows: [{ code }] } = await c.query(`SELECT 'S' || lpad(nextval('sample_seq')::text, 8, '0') AS code`);
    await c.query('INSERT INTO samples (id, order_id, barcode, sample_type, container, replaces) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), orderId, code, sampleType, container, replaces]);
    return code as string;
  }

  /** Patient books tests/packages for self or family. Online: the place is held until paid. */
  async bookByPatient(actor: Actor, v: { patientId: string; collection: Collection; slotAt: string; items: ItemRef[]; paymentMode: 'ONLINE' | 'AT_CLINIC' }) {
    if (actor.kind !== 'patient') throw forbidden('PATIENTS_ONLY', 'patients book here; doctors order tests from a visit');
    const p = await this.patients.access(v.patientId, actor.id);
    const id = await this.db.tx(async (c) => {
      const x = await this.expand(c, v.items);
      const orderId = await this.insertOrder(c, p, { status: 'BOOKED', bookedBy: actor.id }, x);
      await this.schedule(c, actor, orderId, v.collection, v.slotAt, v.paymentMode);
      const o = await this.row(c, orderId);
      await this.emit(c, o.status === 'PENDING_PAYMENT' ? EventTypes.labOrderPendingPayment : EventTypes.labOrderBooked, o);
      return orderId;
    });
    return this.afterBooking(actor, id);
  }

  /**
   * Staff book tests for a patient at the counter or on the phone (D-3): paper orders, walk-ins, patients without the
   * app. Pay at the lab; the slot running now can be used for a patient who is here.
   */
  async bookByStaff(actor: Actor, v: { patientId: string; branchId: string; slotAt: string; items: ItemRef[] }) {
    if (actor.kind !== 'staff') throw forbidden('STAFF_ONLY', 'staff only');
    await this.atBranch(actor, STAFF_BOOK, v.branchId, 'branch');
    const p = await this.patients.get(v.patientId);
    const id = await this.db.tx(async (c) => {
      const x = await this.expand(c, v.items);
      const orderId = await this.insertOrder(c, p, { status: 'BOOKED', bookedBy: actor.id }, x);
      await this.schedule(c, actor, orderId, { type: 'AT_LAB', branchId: v.branchId }, v.slotAt, 'AT_CLINIC', { leadMinutes: STAFF_LEAD_MINUTES });
      const o = await this.row(c, orderId);
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: actor.email ?? null, action: 'CREATE', resourceType: 'LAB_ORDER', resourceId: orderId, patientId: p.id, purpose: 'TREATMENT' });
      await this.emit(c, EventTypes.labOrderBooked, o);
      return orderId;
    });
    return this.dto(await this.db.current(), await this.row(await this.db.current(), id));
  }

  /** Staff give a time to tests a doctor ordered (AWAITING_BOOKING) or a rejected sample, for the patient (D-3). */
  async scheduleByStaff(actor: Actor, orderId: string, v: { branchId: string; slotAt: string }) {
    if (actor.kind !== 'staff') throw forbidden('STAFF_ONLY', 'staff only');
    await this.atBranch(actor, STAFF_BOOK, v.branchId, 'branch');
    await this.db.tx(async (c) => {
      const o = await this.row(c, orderId, true);
      if (!o) throw notFound('lab order');
      if (!['AWAITING_BOOKING', 'SAMPLE_REJECTED'].includes(o.status)) throw conflict('ALREADY_BOOKED', `this order is ${o.status.toLowerCase().replace('_', ' ')}`);
      await this.schedule(c, actor, orderId, { type: 'AT_LAB', branchId: v.branchId }, v.slotAt, 'AT_CLINIC', { leadMinutes: STAFF_LEAD_MINUTES });
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: actor.email ?? null, action: 'UPDATE', resourceType: 'LAB_ORDER', resourceId: orderId, patientId: o.patient_id, purpose: 'TREATMENT', changes: ['scheduled'] });
      await this.emit(c, EventTypes.labOrderBooked, await this.row(c, orderId));
    });
    const c = await this.db.current();
    return this.dto(c, await this.row(c, orderId));
  }

  /** A patient's lab orders still waiting for a time (doctor-ordered, missed home visit, rejected sample): the desk books them. */
  async waitingForTime(actor: Actor, patientId: string) {
    await this.patients.get(patientId); // a patient of this hospital (404 otherwise)
    const c = await this.db.current();
    const { rows } = await c.query(`SELECT o.*, b.name AS branch_name, b.timezone FROM lab_orders o LEFT JOIN branches b ON b.id = o.branch_id
      WHERE o.patient_id = $1 AND o.status IN ('AWAITING_BOOKING','SAMPLE_REJECTED') ORDER BY o.created_at DESC LIMIT 20`, [patientId]);
    if (rows.length) await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: actor.email ?? null, action: 'READ', resourceType: 'LAB_ORDER', patientId, purpose: 'TREATMENT' });
    return Promise.all(rows.map((o) => this.dto(c, o)));
  }

  /** The patient picks a time for tests their doctor ordered, or a new home visit after a missed one. */
  async scheduleByPatient(actor: Actor, orderId: string, v: { collection: Collection; slotAt: string; paymentMode: 'ONLINE' | 'AT_CLINIC' }) {
    if (actor.kind !== 'patient') throw forbidden('PATIENTS_ONLY', 'patients only');
    await this.db.tx(async (c) => {
      const o = await this.row(c, orderId, true);
      if (!o || o.account_person_id !== actor.id) throw notFound('lab order');
      // AWAITING_BOOKING: doctor-ordered or a missed home visit; SAMPLE_REJECTED: a new sample is needed (no extra charge)
      if (!['AWAITING_BOOKING', 'SAMPLE_REJECTED'].includes(o.status)) throw conflict('ALREADY_BOOKED', `this order is ${o.status.toLowerCase().replace('_', ' ')}`);
      await this.schedule(c, actor, orderId, v.collection, v.slotAt, v.paymentMode);
      const u = await this.row(c, orderId);
      await this.emit(c, u.status === 'PENDING_PAYMENT' ? EventTypes.labOrderPendingPayment : EventTypes.labOrderBooked, u);
    });
    return this.afterBooking(actor, orderId);
  }

  /** After the commit: online → invoice + gateway order (billing down → the hold is released at once). */
  private async afterBooking(actor: Actor, orderId: string) {
    const c = await this.db.current();
    const o = await this.row(c, orderId);
    if (o.status !== 'PENDING_PAYMENT') return this.dto(c, o);
    try {
      const payment = await this.billing.openOnline({
        sourceType: 'LAB_ORDER', sourceId: o.id, patientId: o.patient_id, patientName: o.patient_name, patientMrn: o.patient_mrn, accountPersonId: o.account_person_id,
        branchId: o.branch_id, branchName: o.branch_name, description: `Lab tests ${o.order_no}: ${(await this.testNames(c, o.id)).join(', ')}`.slice(0, 290),
        amount: money(o.total), expiresAt: new Date(o.hold_expires_at).toISOString(),
      });
      await c.query('UPDATE lab_orders SET invoice_id = $2 WHERE id = $1', [o.id, payment.invoiceId]);
      return { ...(await this.dto(c, await this.row(c, o.id))), payment };
    } catch (e) {
      await this.db.tx((t) => this.expire(t, [o.id]));
      throw e;
    }
  }

  /** A treating doctor orders tests during a visit; the patient then books a collection time (and pays). */
  async orderByDoctor(actor: Actor, v: { patientId: string; encounterId: string | null; items: ItemRef[]; note: string | null }) {
    if (actor.kind !== 'staff') throw forbidden('DOCTORS_ONLY', 'doctors only');
    const a = await this.care.check(actor.id, v.patientId);
    if (!a.allowed || a.purpose !== 'TREATMENT') throw new DomainError(403, 'NO_TREATING_RELATIONSHIP', 'you can order tests only for patients you are treating');
    const p = await this.patients.get(v.patientId);
    return this.db.tx(async (c) => {
      const x = await this.expand(c, v.items);
      const id = await this.insertOrder(c, p, { orderedBy: { doctorId: a.doctorId, name: a.doctorName }, encounterId: v.encounterId, note: v.note, status: 'AWAITING_BOOKING', bookedBy: actor.id }, x);
      const o = await this.row(c, id);
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: a.doctorName, action: 'CREATE', resourceType: 'LAB_ORDER', resourceId: id, patientId: p.id, purpose: 'TREATMENT' });
      await this.emit(c, EventTypes.labOrderOrdered, o);
      return this.dto(c, o);
    });
  }

  async cancel(actor: Actor, orderId: string, reason: string | null) {
    return this.db.tx(async (c) => {
      const o = await this.row(c, orderId, true);
      if (!o) throw notFound('lab order');
      // cancelling is its own permission (reading the worklist no longer implies it, review B-4), at the order's branch
      const staff = actor.kind === 'staff' && inBranch(await this.caps(actor), 'lab_order:cancel:branch', o.branch_id);
      if (actor.kind === 'patient' ? o.account_person_id !== actor.id : !staff) throw notFound('lab order');
      if (!['AWAITING_BOOKING', 'PENDING_PAYMENT', 'BOOKED'].includes(o.status)) throw conflict('INVALID_STATE_TRANSITION', 'samples have been collected; ask the lab');
      const { rows: [v] } = await c.query('SELECT * FROM home_visits WHERE order_id = $1 FOR UPDATE', [orderId]);
      if (v && ['EN_ROUTE', 'ARRIVED'].includes(v.status)) throw conflict('COLLECTOR_ON_THE_WAY', 'the sample collector is already on the way; please call the lab');
      if (v) {
        await c.query(`UPDATE home_visits SET status = 'CANCELLED', version = version + 1, updated_at = now() WHERE id = $1`, [v.id]);
        await this.visitLog(c, v.id, 'CANCELLED', actor);
      }
      await c.query(`UPDATE lab_orders SET status = 'CANCELLED', cancel_reason = $2, cancelled_at = now(), hold_expires_at = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
        [orderId, reason ?? (actor.kind === 'patient' ? 'PATIENT_CANCELLED' : 'CANCELLED_BY_LAB')]);
      await c.query(`UPDATE samples SET status = 'REJECTED', rejected_reason = 'order cancelled' WHERE order_id = $1 AND status = 'PENDING'`, [orderId]);
      const u = await this.row(c, orderId);
      // nothing collected yet → everything paid comes back
      await this.emit(c, EventTypes.labOrderCancelled, u, { refundPercent: HAS_MONEY.includes(o.payment_status) ? 100 : null });
      return this.dto(c, u);
    });
  }

  /** Online holds never paid → EXPIRED (frees the place). `ids` = specific orders (billing unavailable). */
  async expire(c: Queryable, ids?: string[]) {
    const { rows } = await c.query(
      `UPDATE lab_orders SET status = 'EXPIRED', hold_expires_at = NULL, version = version + 1, updated_at = now()
       WHERE id IN (SELECT id FROM lab_orders WHERE status = 'PENDING_PAYMENT' AND ${ids ? 'id = ANY($1)' : 'hold_expires_at < now() AND $1::uuid[] IS NULL'} LIMIT 500 FOR UPDATE SKIP LOCKED)
       RETURNING id`, [ids ?? null]);
    for (const r of rows) {
      await c.query(`UPDATE home_visits SET status = 'CANCELLED', version = version + 1, updated_at = now() WHERE order_id = $1 AND status = 'UNASSIGNED'`, [r.id]);
      await this.emit(c, EventTypes.labOrderExpired, await this.row(c, r.id));
    }
    return rows.length;
  }

  // ---------- payment saga (billing events) ----------

  async onPaymentSucceeded(c: Queryable, p: { invoiceId: string; paymentId: string; sourceId: string }) {
    const o = await this.row(c, p.sourceId, true);
    if (!o) return;
    const paid = () => c.query(`UPDATE lab_orders SET payment_status = 'PAID', invoice_id = $2, hold_expires_at = NULL, version = version + 1, updated_at = now() WHERE id = $1`, [o.id, p.invoiceId]);
    if (o.status === 'PENDING_PAYMENT') {
      await paid();
      await c.query(`UPDATE lab_orders SET status = 'BOOKED' WHERE id = $1`, [o.id]);
      await this.emit(c, EventTypes.labOrderBooked, await this.row(c, o.id));
      return;
    }
    if (o.status === 'EXPIRED') {
      // late payment: keep the booking if the slot still has room and is in the future
      const { rows: [s] } = await c.query(
        `SELECT (SELECT count(*) FROM lab_orders x WHERE x.branch_id = $1 AND x.collection_type = $3 AND x.slot_at = $2 AND x.status IN ${OCCUPYING})::int AS taken,
                (SELECT w.capacity FROM collection_windows w, branches b WHERE b.id = $1 AND w.branch_id = $1 AND w.kind = $4 AND w.day_of_week = extract(isodow FROM ($2::timestamptz AT TIME ZONE b.timezone))
                   AND ($2::timestamptz AT TIME ZONE b.timezone)::time >= w.start_time AND ($2::timestamptz AT TIME ZONE b.timezone)::time < w.end_time LIMIT 1) AS capacity`, [o.branch_id, o.slot_at, o.collection_type, kindOf(o.collection_type)]);
      if (s?.capacity && s.taken < s.capacity && new Date(o.slot_at) > new Date()) {
        await paid();
        await c.query(`UPDATE lab_orders SET status = 'BOOKED' WHERE id = $1`, [o.id]);
        await c.query(`UPDATE home_visits SET status = 'UNASSIGNED', version = version + 1, updated_at = now() WHERE order_id = $1 AND status = 'CANCELLED'`, [o.id]);
        await this.emit(c, EventTypes.labOrderBooked, await this.row(c, o.id));
        return;
      }
    }
    if (o.status === 'EXPIRED' || o.status === 'CANCELLED') {
      await c.query(`UPDATE lab_orders SET payment_status = 'PAID', invoice_id = $2 WHERE id = $1`, [o.id, p.invoiceId]);
      await addToOutbox(c, Topics.diagnostics, o.id, envelope(EventTypes.labPaymentUnapplied, { appointmentId: o.id, invoiceId: p.invoiceId, paymentId: p.paymentId, reason: o.status === 'CANCELLED' ? 'APPOINTMENT_CANCELLED' : 'SLOT_LOST' }, { tenantId: this.tid(), subject: o.id }));
      return;
    }
    await paid(); // a counter payment for a booked order (or a duplicate)
  }

  async onRefundProcessed(c: Queryable, r: { invoiceId: string; invoiceStatus: string }) {
    const status = r.invoiceStatus === 'REFUNDED' ? 'REFUNDED' : r.invoiceStatus === 'PARTIALLY_REFUNDED' ? 'PARTIALLY_REFUNDED' : null;
    if (status) await c.query('UPDATE lab_orders SET payment_status = $2 WHERE invoice_id = $1', [r.invoiceId, status]);
  }

  // ---------- reading ----------

  async row(c: Queryable, id: string, lock = false) {
    const { rows } = await c.query(`SELECT o.*, b.name AS branch_name, b.timezone FROM lab_orders o LEFT JOIN branches b ON b.id = o.branch_id WHERE o.id = $1${lock ? ' FOR UPDATE OF o' : ''}`, [id]);
    return rows[0];
  }

  private async testNames(c: Queryable, id: string): Promise<string[]> {
    return (await c.query('SELECT test_name FROM lab_order_items WHERE order_id = $1 ORDER BY test_name', [id])).rows.map((r) => r.test_name);
  }

  async dto(c: Queryable, o: any) {
    const [{ rows: lines }, { rows: items }, { rows: samples }, { rows: [visit] }] = await Promise.all([
      c.query('SELECT * FROM lab_order_lines WHERE order_id = $1 ORDER BY kind DESC, name', [o.id]),
      c.query(`SELECT i.*, t.preparation, t.fasting_hours, t.turnaround_hours FROM lab_order_items i JOIN lab_tests t ON t.id = i.test_id WHERE i.order_id = $1 ORDER BY i.test_name`, [o.id]),
      c.query('SELECT * FROM samples WHERE order_id = $1 ORDER BY created_at', [o.id]),
      c.query('SELECT * FROM home_visits WHERE order_id = $1', [o.id]),
    ]);
    const tz = o.timezone ?? 'Asia/Kolkata';
    return {
      id: o.id, orderNo: o.order_no, status: o.status, paymentMode: o.payment_mode, paymentStatus: o.payment_status, invoiceId: o.invoice_id, total: money(o.total),
      patient: { id: o.patient_id, name: o.patient_name, mrn: o.patient_mrn, dob: o.patient_dob ? new Date(o.patient_dob).toISOString().slice(0, 10) : null, gender: o.patient_gender },
      orderedBy: o.ordered_by_name ? { name: o.ordered_by_name } : null, encounterId: o.encounter_id, note: o.note,
      branch: o.branch_id ? { id: o.branch_id, name: o.branch_name } : null, slotAt: o.slot_at,
      localDate: o.slot_at ? new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(o.slot_at)) : null,
      localTime: o.slot_at ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(o.slot_at)) : null,
      holdExpiresAt: o.hold_expires_at, cancelReason: o.cancel_reason, createdAt: o.created_at,
      collectedAt: o.collected_at ?? null, dueAt: o.due_at ?? null, overdue: !!o.tat_breached_at,
      preparation: preparationFor(items),
      collectionType: o.collection_type ?? 'AT_LAB', homeAddress: o.home_address ?? null,
      homeVisit: visit ? { id: visit.id, status: visit.status, phlebotomistName: visit.phlebotomist_name, attempts: visit.attempts, missedReason: visit.missed_reason } : null,
      lines: lines.map((l) => ({ kind: l.kind, code: l.code, name: l.name, price: money(l.price) })),
      tests: items.map((i) => ({ code: i.test_code, name: i.test_name, sampleType: i.sample_type, status: i.status, turnaroundHours: i.turnaround_hours })),
      samples: samples.map((s) => ({ id: s.id, barcode: s.barcode, sampleType: s.sample_type, container: s.container, status: s.status, collectedAt: s.collected_at, collectedBy: s.collected_by_name, receivedAt: s.received_at, rejectedReason: s.rejected_reason, replaces: s.replaces })),
    };
  }

  async myOrders(actor: Actor) {
    if (actor.kind !== 'patient') throw forbidden('PATIENTS_ONLY', 'patients only');
    const c = await this.db.current();
    const { rows } = await c.query(`SELECT o.*, b.name AS branch_name, b.timezone FROM lab_orders o LEFT JOIN branches b ON b.id = o.branch_id WHERE o.account_person_id = $1 ORDER BY o.created_at DESC LIMIT 100`, [actor.id]);
    return Promise.all(rows.map((o) => this.dto(c, o)));
  }

  /** Owner, lab staff, or a doctor treating the patient. Staff reads are audited. */
  async get(actor: Actor, id: string) {
    const c = await this.db.current();
    const o = await this.row(c, id);
    if (!o) throw notFound('lab order');
    if (actor.kind === 'patient') {
      if (o.account_person_id !== actor.id) throw notFound('lab order');
      return this.dto(c, o);
    }
    const lab = inBranch(await this.caps(actor), 'lab_order:read:branch', o.branch_id);
    const care = lab ? null : await this.care.check(actor.id, o.patient_id);
    if (!lab && !care?.allowed) throw notFound('lab order');
    await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: care?.doctorName ?? actor.email ?? null, action: 'READ', resourceType: 'LAB_ORDER', resourceId: id, patientId: o.patient_id, purpose: lab ? 'TREATMENT' : (care!.purpose as any) });
    return this.dto(c, o);
  }

  /** Lab worklist: one branch, one day, in collection order. */
  async worklist(actor: Actor, branchId: string, date: string | undefined) {
    const c = await this.db.current();
    const { rows: [b] } = await c.query('SELECT * FROM branches WHERE id = $1', [branchId]);
    if (!b) throw notFound('branch');
    const { rows: [{ day }] } = await c.query(`SELECT to_char(coalesce($1::date, (now() AT TIME ZONE $2)::date), 'YYYY-MM-DD') AS day`, [date ?? null, b.timezone]);
    const { rows } = await c.query(
      `SELECT o.*, b.name AS branch_name, b.timezone FROM lab_orders o JOIN branches b ON b.id = o.branch_id
       WHERE o.branch_id = $1 AND o.local_date = $2::date AND o.status <> 'PENDING_PAYMENT' AND o.status <> 'EXPIRED' ORDER BY o.slot_at, o.order_no`, [branchId, day]);
    await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: actor.email ?? null, action: 'READ', resourceType: 'LAB_WORKLIST', purpose: 'TREATMENT' });
    const orders = await Promise.all(rows.map((o) => this.dto(c, o)));
    const count = (s: string) => orders.filter((o) => o.status === s).length;
    return { branch: { id: b.id, name: b.name }, date: day, totals: { booked: count('BOOKED'), collected: count('SAMPLE_COLLECTED'), inLab: count('IN_LAB'), rejected: count('SAMPLE_REJECTED'), resultsEntered: count('RESULTS_ENTERED'), published: count('REPORT_PUBLISHED'), cancelled: count('CANCELLED') }, orders };
  }

  /** Lab: everything waiting for results or verification at a branch, any day, oldest (and overdue) first. */
  async pending(actor: Actor, branchId: string) {
    const c = await this.db.current();
    const { rows } = await c.query(
      `SELECT o.*, b.name AS branch_name, b.timezone FROM lab_orders o JOIN branches b ON b.id = o.branch_id
       WHERE o.branch_id = $1 AND o.status IN ('SAMPLE_COLLECTED','IN_LAB','RESULTS_ENTERED') ORDER BY (o.tat_breached_at IS NULL), o.due_at NULLS LAST LIMIT 200`, [branchId]);
    await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: actor.email ?? null, action: 'READ', resourceType: 'LAB_WORKLIST', purpose: 'TREATMENT' });
    return Promise.all(rows.map((o) => this.dto(c, o)));
  }

  // ---------- samples (lab technician) ----------

  async sampleByBarcode(c: Queryable, barcode: string) {
    const { rows } = await c.query(`SELECT s.*, o.status AS order_status, o.payment_status, o.patient_id, o.local_date, o.branch_id, o.collection_type, (now() AT TIME ZONE coalesce(b.timezone, 'Asia/Kolkata'))::date AS today
      FROM samples s JOIN lab_orders o ON o.id = s.order_id LEFT JOIN branches b ON b.id = o.branch_id WHERE s.barcode = upper($1) FOR UPDATE OF s, o`, [barcode.trim()]);
    if (!rows[0]) throw notFound('sample');
    return rows[0];
  }

  private async techName(actor: Actor) { return actor.email ?? 'Lab technician'; }

  /** Scan at collection: the order must be paid and for today; when every tube is in, the order is SAMPLE_COLLECTED. */
  async collect(actor: Actor, barcode: string) {
    return this.db.tx(async (c) => {
      const s = await this.sampleByBarcode(c, barcode);
      await this.atBranch(actor, 'sample:collect:branch', s.branch_id, 'sample');
      // a replacement tube (after a rejection) may be collected at the counter, home orders included: the patient
      // was told to visit the lab
      if (s.collection_type === 'HOME' && !s.replaces) throw conflict('HOME_COLLECTION', `sample ${s.barcode} is collected at the patient's home by the phlebotomist`);
      return this.collectSample(c, actor, s);
    });
  }

  /** Shared by the lab counter and the phlebotomist at the patient's home (who has checked the visit). */
  async collectSample(c: Queryable, actor: Actor, s: any) {
    if (s.status !== 'PENDING') throw conflict('ALREADY_COLLECTED', `sample ${s.barcode} is ${s.status.toLowerCase()}`);
    if (!['BOOKED', 'SAMPLE_REJECTED', 'SAMPLE_COLLECTED'].includes(s.order_status)) throw conflict('INVALID_STATE_TRANSITION', `the order is ${s.order_status.toLowerCase().replace('_', ' ')}`);
    if (!['PAID', 'NOT_DUE'].includes(s.payment_status)) throw new DomainError(409, 'PAYMENT_REQUIRED', 'take the payment before collecting');
    // replacement tubes can be collected any day (the patient comes back when they can)
    if (!s.replaces && String(new Date(s.local_date).toISOString().slice(0, 10)) !== new Date(s.today).toISOString().slice(0, 10)) throw new DomainError(422, 'NOT_TODAY', 'this booking is for another day');
    const name = await this.techName(actor);
    await c.query(`UPDATE samples SET status = 'COLLECTED', collected_by = $2, collected_by_name = $3, collected_at = now() WHERE id = $1`, [s.id, actor.id, name]);
    // the turnaround clock starts at the first tube: due = longest turnaround of the order's tests
    await c.query(`UPDATE lab_orders o SET collected_at = now(), due_at = now() + make_interval(hours => (SELECT max(t.turnaround_hours) FROM lab_order_items i JOIN lab_tests t ON t.id = i.test_id WHERE i.order_id = o.id))
                   WHERE o.id = $1 AND o.collected_at IS NULL`, [s.order_id]);
    const { rows: [{ pending }] } = await c.query(`SELECT count(*)::int AS pending FROM samples WHERE order_id = $1 AND status = 'PENDING'`, [s.order_id]);
    if (!pending) {
      await c.query(`UPDATE lab_orders SET status = 'SAMPLE_COLLECTED', version = version + 1, updated_at = now() WHERE id = $1`, [s.order_id]);
      await this.emit(c, EventTypes.labOrderCollected, await this.row(c, s.order_id));
    }
    await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: name, action: 'UPDATE', resourceType: 'SAMPLE', resourceId: s.id, patientId: s.patient_id, purpose: 'TREATMENT', changes: ['collected'] });
    return { barcode: s.barcode, pendingSamples: pending as number, order: await this.dto(c, await this.row(c, s.order_id)) };
  }

  /** Sample arrives at the lab bench; all in → IN_LAB (results in Phase 15). */
  async receive(actor: Actor, barcode: string) {
    return this.db.tx(async (c) => {
      const s = await this.sampleByBarcode(c, barcode);
      await this.atBranch(actor, 'sample:collect:branch', s.branch_id, 'sample');
      if (s.status !== 'COLLECTED') throw conflict('INVALID_STATE_TRANSITION', `sample ${s.barcode} is ${s.status.toLowerCase()}`);
      await c.query(`UPDATE samples SET status = 'RECEIVED', received_at = now() WHERE id = $1`, [s.id]);
      // home collection: the first tube scanned at the bench is the phlebotomist's hand-over
      const { rows: handed } = await c.query(`UPDATE home_visits SET status = 'HANDED_OVER', version = version + 1, updated_at = now() WHERE order_id = $1 AND status = 'COLLECTED' RETURNING id`, [s.order_id]);
      if (handed[0]) await this.visitLog(c, handed[0].id, 'HANDED_OVER', actor, 'received at the lab');
      const { rows: [{ open }] } = await c.query(`SELECT count(*)::int AS open FROM samples WHERE order_id = $1 AND status IN ('PENDING','COLLECTED')`, [s.order_id]);
      if (!open) {
        await c.query(`UPDATE lab_orders SET status = 'IN_LAB', version = version + 1, updated_at = now() WHERE id = $1`, [s.order_id]);
        await this.emit(c, EventTypes.labOrderInLab, await this.row(c, s.order_id));
      }
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: await this.techName(actor), action: 'UPDATE', resourceType: 'SAMPLE', resourceId: s.id, patientId: s.patient_id, purpose: 'TREATMENT', changes: ['received'] });
      return this.dto(c, await this.row(c, s.order_id));
    });
  }

  /**
   * Tests without a sample (X-ray, ECG, scans): the patient was seen at the lab, so the order goes to the bench for
   * the report, the way the last tube scan would (docs/ROLE-FLOWS-AND-GAPS.md D-2). Same rules as a collection:
   * booked, paid, today.
   */
  async performed(actor: Actor, orderId: string) {
    return this.db.tx(async (c) => {
      const o = await this.row(c, orderId, true);
      if (!o) throw notFound('lab order');
      await this.atBranch(actor, 'sample:collect:branch', o.branch_id);
      const { rows: [{ tubes }] } = await c.query(`SELECT count(*)::int AS tubes FROM samples WHERE order_id = $1`, [orderId]);
      if (tubes) throw conflict('HAS_SAMPLES', 'this order has samples: scan them instead');
      if (o.status !== 'BOOKED') throw conflict('INVALID_STATE_TRANSITION', `the order is ${o.status.toLowerCase().replace('_', ' ')}`);
      if (!['PAID', 'NOT_DUE'].includes(o.payment_status)) throw new DomainError(409, 'PAYMENT_REQUIRED', 'take the payment first');
      const { rows: [{ today }] } = await c.query(`SELECT ($2::date = (now() AT TIME ZONE coalesce((SELECT timezone FROM branches WHERE id = $1), 'Asia/Kolkata'))::date) AS today`, [o.branch_id, o.local_date]);
      if (!today) throw new DomainError(422, 'NOT_TODAY', 'this booking is for another day');
      await c.query(`UPDATE lab_orders o SET status = 'IN_LAB', collected_at = now(),
          due_at = now() + make_interval(hours => (SELECT max(t.turnaround_hours) FROM lab_order_items i JOIN lab_tests t ON t.id = i.test_id WHERE i.order_id = o.id)),
          version = version + 1, updated_at = now() WHERE id = $1`, [orderId]);
      await this.emit(c, EventTypes.labOrderInLab, await this.row(c, orderId));
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: await this.techName(actor), action: 'UPDATE', resourceType: 'LAB_ORDER', resourceId: orderId, patientId: o.patient_id, purpose: 'TREATMENT', changes: ['performed'] });
      return this.dto(c, await this.row(c, orderId));
    });
  }

  /** Haemolysed / not enough: the tube is rejected and a new label is issued for recollection. */
  async reject(actor: Actor, barcode: string, reason: string) {
    return this.db.tx(async (c) => {
      const s = await this.sampleByBarcode(c, barcode);
      await this.atBranch(actor, 'sample:collect:branch', s.branch_id, 'sample');
      if (!['COLLECTED', 'RECEIVED'].includes(s.status)) throw conflict('INVALID_STATE_TRANSITION', `sample ${s.barcode} is ${s.status.toLowerCase()}`);
      // once results are entered, a wrong result is corrected by an amendment (with history), not by hiding the report
      if (['RESULTS_ENTERED', 'REPORT_PUBLISHED', 'CANCELLED'].includes(s.order_status)) throw conflict('RESULTS_ALREADY_ENTERED', 'results are already entered for this order: correct them with an amendment instead');
      await c.query(`UPDATE samples SET status = 'REJECTED', rejected_reason = $2 WHERE id = $1`, [s.id, reason]);
      const replacement = await this.newSample(c, s.order_id, s.sample_type, s.container, s.id);
      await c.query(`UPDATE lab_orders SET status = 'SAMPLE_REJECTED', version = version + 1, updated_at = now() WHERE id = $1`, [s.order_id]);
      await this.emit(c, EventTypes.labOrderSampleRejected, await this.row(c, s.order_id));
      await this.audit.record({ actorId: actor.id, actorKind: 'staff', actorName: await this.techName(actor), action: 'UPDATE', resourceType: 'SAMPLE', resourceId: s.id, patientId: s.patient_id, purpose: 'TREATMENT', changes: ['rejected'] });
      return { rejected: s.barcode, replacement, order: await this.dto(c, await this.row(c, s.order_id)) };
    });
  }

  // ---------- events ----------

  async emit(c: Queryable, type: string, o: any, extra: Partial<LabOrderChanged> = {}) {
    const d = await this.dto(c, o);
    const data: LabOrderChanged = {
      orderId: o.id, orderNo: o.order_no, patientId: o.patient_id, accountPersonId: o.account_person_id, patientName: o.patient_name, patientMrn: o.patient_mrn,
      branchId: o.branch_id, branchName: o.branch_name ?? null, status: o.status, paymentMode: o.payment_mode, paymentStatus: o.payment_status, invoiceId: o.invoice_id,
      total: money(o.total), testNames: d.tests.map((t) => t.name), slotAt: o.slot_at ? new Date(o.slot_at).toISOString() : null,
      localDate: d.localDate, localTime: d.localTime, preparation: d.preparation, orderedByDoctorId: o.ordered_by_doctor_id, orderedByName: o.ordered_by_name, encounterId: o.encounter_id,
      collectionType: o.collection_type ?? 'AT_LAB',
      ...extra,
    };
    await addToOutbox(c, Topics.diagnostics, o.id, envelope(type, data, { tenantId: this.tid(), subject: o.id }));
  }
}

export const toTest = (t: any) => ({
  id: t.id, code: t.code, name: t.name, category: t.category, sampleType: t.sample_type, container: t.container, preparation: t.preparation,
  fastingHours: t.fasting_hours, turnaroundHours: t.turnaround_hours, price: money(t.price), aliases: t.aliases, active: t.active, referenceRanges: t.reference_ranges,
});
export const toPackage = (p: any) => ({
  id: p.id, code: p.code, name: p.name, description: p.description, price: money(p.price), active: p.active,
  tests: p.tests ?? [], worth: (p.tests ?? []).reduce((s: number, t: any) => s + money(t.price), 0),
  preparation: preparationFor((p.tests ?? []).map((t: any) => ({ preparation: t.preparation, fasting_hours: t.fastingHours }))),
});
