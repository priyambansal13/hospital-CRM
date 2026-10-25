import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { AppointmentChanged, EventEnvelope, EventTypes, type QueueSignal, Topics } from '@mc/contracts';
import { createConsumer } from '@mc/kafka';
import { randomUUID } from 'node:crypto';

/** Appointment events that change what a queue screen or desk board shows. */
const QUEUE_EVENTS = new Set<string>([
  EventTypes.appointmentBooked, EventTypes.appointmentCancelled, EventTypes.appointmentRescheduled,
  EventTypes.appointmentCheckedIn, EventTypes.appointmentStarted, EventTypes.appointmentCompleted, EventTypes.appointmentNoShow,
]);

export interface Subscriber {
  tenantId: string;
  /** a doctor's queue, or a whole branch (desk board) */
  doctorId?: string;
  branchId?: string;
  send(signal: QueueSignal): void;
}

/**
 * In-memory fan-out. Every instance reads the whole scheduling topic in its own consumer group (from "now"), so a
 * browser can connect to any replica. Nothing is stored: a screen that reconnects re-fetches its data anyway.
 */
@Injectable()
export class QueueHub implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('QueueHub');
  private readonly subs = new Set<Subscriber>();
  private consumer?: { disconnect(): Promise<void> };

  async onApplicationBootstrap() {
    if (process.env.MC_DISABLE_EVENTS === 'true') return;
    const group = `realtime-${randomUUID()}`;
    this.consumer = await createConsumer('realtime-service', group, [Topics.scheduling], async (m) => this.onMessage(m.value), { fromBeginning: false });
    this.log.log(`listening on ${Topics.scheduling} (group ${group})`);
  }

  async onApplicationShutdown() {
    await this.consumer?.disconnect().catch(() => undefined);
  }

  get size() {
    return this.subs.size;
  }

  countFor(tenantId: string) {
    let n = 0;
    for (const s of this.subs) if (s.tenantId === tenantId) n++;
    return n;
  }

  subscribe(s: Subscriber) {
    this.subs.add(s);
    return () => this.subs.delete(s);
  }

  /** Exposed for tests. */
  onMessage(raw: string | null) {
    let evt: EventEnvelope<unknown>;
    try {
      evt = EventEnvelope.parse(JSON.parse(raw ?? 'null')) as EventEnvelope<unknown>;
    } catch {
      return;
    }
    if (!evt.tenantId || !QUEUE_EVENTS.has(evt.type)) return;
    const a = AppointmentChanged.safeParse(evt.data);
    if (!a.success) return;
    const signal: QueueSignal = {
      type: evt.type, appointmentId: a.data.appointmentId, doctorId: a.data.doctorId, branchId: a.data.branchId,
      status: a.data.status, tokenNo: a.data.tokenNo ?? null, localDate: a.data.localDate ?? null,
    };
    for (const s of this.subs) {
      if (s.tenantId !== evt.tenantId) continue;
      if ((s.doctorId && s.doctorId === signal.doctorId) || (s.branchId && s.branchId === signal.branchId)) s.send(signal);
    }
  }
}
