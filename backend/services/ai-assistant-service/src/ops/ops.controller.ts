import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { branchesFor, EntitlementsClient, inBranch, RequireFeature, RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { CurrentActor, DomainError, Internal, notFound, parse, PLACEMENTS } from '@mc/nest-common';
import { type Actor, type PlacementSource, TenantContext } from '@mc/tenancy';
import { z } from 'zod';
import { OpsAgentService } from './agent.js';
import { BriefService } from './brief.js';
import { CARE_GAP_RULES, type CareGapRule, CareGapService } from './care-gaps.js';

const uuid = (v: string, what: string) => { if (!z.uuid().safeParse(v).success) throw notFound(what); return v; };
const rule = (v: string) => { if (!(v in CARE_GAP_RULES)) throw notFound('care-gap rule'); return v as CareGapRule; };
const Ask = z.object({ question: z.string() });
const Rate = z.object({ rating: z.union([z.literal(1), z.literal(-1)]) });
const Wording = z.object({ subject: z.string().max(200).optional(), body: z.string().max(1000).optional(), status: z.enum(['APPROVED', 'OFF', 'DRAFT']), version: z.number().int() });

/** The Ops agent: admins ask about the hospital's numbers (their own branches); the answers' history. */
@Controller('v1/assistant/ops')
@RequireModule('ai_ops')
export class OpsController {
  constructor(private readonly agent: OpsAgentService, private readonly briefs: BriefService, private readonly entitlements: EntitlementsClient) {}

  @Post('ask')
  @HttpCode(200)
  @RequirePermission('ops_agent:use:branch')
  @RequireFeature('ai_ops.agent')
  ask(@Body() body: unknown, @CurrentActor() actor: Actor) { return this.agent.ask(actor, parse(Ask, body).question); }

  @Get('questions')
  @RequirePermission('ops_agent:use:branch')
  history(@CurrentActor() actor: Actor) { return this.agent.history(actor); }

  @Post('questions/:id/rating')
  @HttpCode(204)
  @RequirePermission('ops_agent:use:branch')
  rate(@Param('id') id: string, @Body() body: unknown, @CurrentActor() actor: Actor) { return this.agent.rate(actor, uuid(id, 'question'), parse(Rate, body).rating); }

  /** The latest brief of each branch the person manages. */
  @Get('briefs')
  @RequirePermission('ops_brief:receive:branch')
  async latestBriefs(@CurrentActor() actor: Actor) {
    const caps = await this.entitlements.capabilities(TenantContext.require().id, actor);
    return this.briefs.latest(branchesFor(caps, 'ops_brief:receive:branch'));
  }

  /** Today's brief again, now (no e-mail): after a busy morning, or for a branch that has none yet. */
  @Post('briefs/:branchId')
  @HttpCode(200)
  @RequirePermission('ops_brief:receive:branch')
  @RequireFeature('ai_ops.brief')
  async remake(@Param('branchId') b: string, @CurrentActor() actor: Actor) {
    const t = TenantContext.require();
    const caps = await this.entitlements.capabilities(t.id, actor);
    if (!inBranch(caps, 'ops_brief:receive:branch', uuid(b, 'branch'))) throw new DomainError(403, 'OUTSIDE_BRANCH', 'that branch is not one of yours');
    return this.briefs.make(t, b, false);
  }
}

/** Care-gap reminders: the rules, the drafted wording to approve, a run now. Hospital-wide. */
@Controller('v1/assistant/ops/care-gaps')
@RequireModule('ai_ops')
@RequirePermission('care_gap:manage:tenant')
@RequireFeature('ai_ops.care_gaps')
export class CareGapsController {
  constructor(private readonly gaps: CareGapService) {}

  @Get() list() { return this.gaps.list(); }

  @Post('draft')
  @HttpCode(200)
  draft() { return this.gaps.draft(); }

  @Put(':rule')
  update(@Param('rule') r: string, @Body() body: unknown, @CurrentActor() actor: Actor) { return this.gaps.update(actor, rule(r), parse(Wording, body)); }

  @Post(':rule/run')
  @HttpCode(200)
  run(@Param('rule') r: string) { return this.gaps.run(TenantContext.require(), rule(r)); }
}

/** Jobs on demand (tests, operations): the briefs due now (any hour with `hour: 0`), finished Batch Mode jobs. */
@Controller('internal/tenants/:tenantId/ops')
export class InternalOpsController {
  constructor(private readonly briefs: BriefService, private readonly gaps: CareGapService, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Post('briefs')
  @Internal()
  @HttpCode(200)
  async briefsDue(@Param('tenantId') t: string, @Body() body: { hour?: number }) {
    const p = await this.placements.get(uuid(t, 'tenant'));
    return { made: await this.briefs.runTenant(p, typeof body?.hour === 'number' ? body.hour : undefined) };
  }

  @Post('batches')
  @Internal()
  @HttpCode(200)
  async batches(@Param('tenantId') t: string) {
    const p = await this.placements.get(uuid(t, 'tenant'));
    await TenantContext.run(p, () => this.gaps.poll(p));
    return { ok: true };
  }
}
