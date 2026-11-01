import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { TenantPlacement } from '@mc/contracts';
import { EntitlementsClient } from '@mc/entitlements-sdk';
import { ModuleHooks, PLACEMENTS, retryInBackground } from '@mc/nest-common';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import type { AppointmentFact, LabOrderFact, PaymentFact, PatientFact } from './loader.js';
import { WarehouseLoader } from './loader.js';

const svc = (name: string, port: number) => process.env[`SVC_URL_${name}`] ?? `http://localhost:${port}`;
const SOURCES = {
  patients: { url: svc('PATIENT', 4406), path: 'patients' },
  appointments: { url: svc('SCHEDULING', 4405), path: 'appointments' },
  lab_orders: { url: svc('DIAGNOSTICS', 4412), path: 'lab-orders' },
  payments: { url: svc('BILLING', 4409), path: 'payments' },
} as const;
type Source = keyof typeof SOURCES;
const PAGE = 1000;

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${new URL(url).port} ${res.status}`);
  return (await res.json()) as T;
}
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * Fills the warehouse from the owning services (internal, ids only), for what happened before the consumers listened:
 * once when the module is switched on (and on start for hospitals that never finished), page by page, each page in
 * its own transaction. Dimensions and doctors' bookable time (not events) are refreshed every 30 minutes.
 */
@Injectable()
export class Backfill implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Warehouse');
  private readonly running = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: TenantDbRouter, private readonly loader: WarehouseLoader, private readonly hooks: ModuleHooks,
    @Inject(PLACEMENTS) private readonly placements: PlacementSource, private readonly entitlements: EntitlementsClient,
  ) {}

  onModuleInit() {
    // the hook runs inside entitlement-service's retry loop: start the load after it, never block it
    // (switched on again after a while off: the earlier load no longer counts until this one is done)
    this.hooks.register('analytics', {
      enable: async (c) => {
        const t = TenantContext.require();
        await c.query(`UPDATE loads SET status = 'PENDING', finished_at = NULL`);
        setImmediate(() => void this.start(t));
      },
    });
  }

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    retryInBackground('WarehouseSetup', () => this.all(true));
    this.timer = setInterval(() => void this.all(false).catch((e) => this.log.warn((e as Error).message)), Number(process.env.ANALYTICS_REFRESH_MS ?? 30 * 60_000));
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  private async all(resume: boolean) {
    for (const t of await this.placements.list()) {
      if (t.status !== 'ACTIVE' || (await this.entitlements.moduleState(t.id, 'analytics')) !== 'ACTIVE') continue;
      if (resume) {
        const done = await TenantContext.run(t, () => this.db.query(`SELECT count(*)::int n FROM loads WHERE status = 'DONE'`)).then((r) => r.rows[0].n as number).catch(() => 0);
        if (done < Object.keys(SOURCES).length) { void this.start(t); continue; }
      }
      await this.refresh(t).catch((e) => this.log.warn(`${t.slug}: refresh: ${(e as Error).message}`));
    }
  }

  /** The whole load for one hospital (skipped if one is already running here). */
  async start(t: TenantPlacement) {
    if (this.running.has(t.id)) return { started: false };
    this.running.add(t.id);
    try {
      await this.refresh(t);
      for (const s of Object.keys(SOURCES) as Source[]) await this.load(t, s);
      this.log.log(`${t.slug}: warehouse loaded`);
      return { started: true };
    } catch (e) {
      this.log.warn(`${t.slug}: backfill: ${(e as Error).message}`);
      return { started: true, error: (e as Error).message };
    } finally {
      this.running.delete(t.id);
    }
  }

  private async load(t: TenantPlacement, s: Source) {
    await TenantContext.run(t, async () => {
      await this.db.query(`INSERT INTO loads (source, status, rows) VALUES ($1, 'RUNNING', 0) ON CONFLICT (source) DO UPDATE SET status = 'RUNNING', rows = 0, started_at = now(), finished_at = NULL, error = NULL`, [s]);
      let after: string | null = null;
      let n = 0;
      try {
        for (;;) {
          const q = `?limit=${PAGE}${after ? `&after=${after}` : ''}`;
          const page: any[] = await get(`${SOURCES[s].url}/internal/tenants/${t.id}/analytics/${SOURCES[s].path}${q}`);
          if (!page.length) break;
          await this.db.tx(async (c) => {
            for (const r of page) {
              if (s === 'patients') await this.loader.patient(c, r as PatientFact);
              else if (s === 'appointments') await this.loader.appointment(c, { ...(r as AppointmentFact), rescheduledFrom: null }, r.updatedAt);
              else if (s === 'lab_orders') await this.loader.labOrder(c, r as LabOrderFact, r.updatedAt);
              else await this.loader.payment(c, r as PaymentFact);
            }
            n += page.length;
            await c.query('UPDATE loads SET rows = $2 WHERE source = $1', [s, n]);
          });
          after = (page.at(-1).id ?? page.at(-1).patientId) as string;
          if (page.length < PAGE) break;
        }
        // pages come in id order, not time order: "first visit" is settled once all appointments are in
        if (s === 'appointments') {
          await this.db.query(`UPDATE fact_appointments f SET first_visit = NOT EXISTS (SELECT 1 FROM fact_appointments p WHERE p.patient_key = f.patient_key AND p.starts_at < f.starts_at AND p.status IN ('COMPLETED','CHECKED_IN','IN_PROGRESS'))`);
        }
        await this.db.query(`UPDATE loads SET status = 'DONE', rows = $2, finished_at = now() WHERE source = $1`, [s, n]);
      } catch (e) {
        await this.db.query(`UPDATE loads SET status = 'FAILED', error = $2 WHERE source = $1`, [s, (e as Error).message.slice(0, 300)]);
        throw e;
      }
    });
  }

  /** Branches, doctors, department names and bookable time (60 days back, 14 ahead). */
  async refresh(t: TenantPlacement, from = day(-60), to = day(14)) {
    const [dims, specialties, capacity] = await Promise.all([
      get<{ branches: any[]; doctors: any[] }>(`${SOURCES.appointments.url}/internal/tenants/${t.id}/analytics/dimensions`),
      get<{ code: string; name: string }[]>(`${svc('PROVIDER', 4404)}/internal/tenants/${t.id}/specialties`).catch(() => []),
      get<{ doctorId: string; branchId: string; localDate: string; slots: number; booked: number }[]>(`${SOURCES.appointments.url}/internal/tenants/${t.id}/analytics/capacity?from=${from}&to=${to}`),
    ]);
    await TenantContext.run(t, () => this.db.tx(async (c) => {
      for (const b of dims.branches) await this.loader.branch(c, b);
      for (const d of dims.doctors) await this.loader.doctor(c, d);
      for (const s of specialties) await this.loader.specialty(c, s);
      await c.query('DELETE FROM fact_capacity WHERE local_date BETWEEN $1 AND $2', [from, to]);
      for (const x of capacity) {
        await c.query('INSERT INTO fact_capacity (doctor_id, branch_id, local_date, slots, booked) VALUES ($1,$2,$3,$4,$5)', [x.doctorId, x.branchId, x.localDate, x.slots, x.booked]);
      }
    }));
  }
}
