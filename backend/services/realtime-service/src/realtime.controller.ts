import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { CurrentActor, DomainError, parse } from '@mc/nest-common';
import { RequireModule } from '@mc/entitlements-sdk';
import { type Actor, TenantContext } from '@mc/tenancy';
import { z } from 'zod';
import { QueueHub } from './hub.js';

const Watch = z.object({ doctorId: z.uuid().optional(), branchId: z.uuid().optional() }).refine((q) => !!q.doctorId !== !!q.branchId, 'give either doctorId or branchId');
const HEARTBEAT_MS = 15_000;
/** Streams end after this; EventSource reconnects through the zone, which refreshes the session first. */
const MAX_STREAM_MS = Number(process.env.REALTIME_MAX_STREAM_MS ?? 10 * 60_000);
const MAX_PER_TENANT = Number(process.env.REALTIME_MAX_PER_TENANT ?? 500);

/**
 * Server-sent events for queue screens (docs/LLD.md §5.7). Pushes a signal per appointment change; screens
 * re-fetch through their own APIs, so nothing clinical travels on the stream and access rules live in one place:
 * scheduling-service decides who may watch which queue.
 */
@Controller('v1/realtime')
@RequireModule('front_desk')
export class RealtimeController {
  constructor(private readonly hub: QueueHub) {}

  @Get('queue')
  async queue(@Query() query: unknown, @CurrentActor() actor: Actor, @Req() req: any, @Res() reply: any) {
    const q = parse(Watch, query);
    const tenant = TenantContext.require();
    await assertMayWatch(actor, tenant.hosts[0], q);
    if (this.hub.countFor(tenant.id) >= MAX_PER_TENANT) throw new DomainError(503, 'TOO_MANY_STREAMS', 'too many live screens open; try again shortly');

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 3000\nevent: ready\ndata: {}\n\n`);
    let open = true;
    const close = () => {
      if (!open) return;
      open = false;
      clearInterval(ping);
      clearTimeout(limit);
      unsubscribe();
      res.end();
    };
    const unsubscribe = this.hub.subscribe({
      tenantId: tenant.id, doctorId: q.doctorId, branchId: q.branchId,
      send: (s) => { if (open) res.write(`event: queue\ndata: ${JSON.stringify(s)}\n\n`); },
    });
    const ping = setInterval(() => open && res.write(`: ping\n\n`), HEARTBEAT_MS);
    const limit = setTimeout(close, MAX_STREAM_MS);
    req.raw.on('close', close);
  }
}

/** Ask scheduling-service with the caller's own token (same rules as the queue API itself). */
async function assertMayWatch(actor: Actor, host: string, q: { doctorId?: string; branchId?: string }) {
  const qs = new URLSearchParams(q.doctorId ? { doctorId: q.doctorId } : { branchId: q.branchId! });
  const res = await fetch(`${process.env.SVC_URL_SCHEDULING ?? 'http://localhost:4405'}/v1/queue/access?${qs}`, {
    headers: { authorization: `Bearer ${actor.token}`, 'x-tenant-host': host },
  });
  if (res.status === 204) return;
  const body = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
  if (res.status === 404 || res.status === 403) throw new DomainError(res.status, body.code ?? 'NOT_FOUND', body.detail ?? 'not found');
  throw new DomainError(502, 'SCHEDULING_UNAVAILABLE', `scheduling-service ${res.status}`);
}
