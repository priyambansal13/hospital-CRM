import { Body, Controller, Get, Injectable, Param, Patch, Post, type OnModuleInit } from '@nestjs/common';
import { Topics } from '@mc/contracts';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { ConsumerRegistry, notFound, parse } from '@mc/nest-common';
import { z } from 'zod';
import { Action, ACTION_LABELS, Condition, factsFor, PLACEHOLDERS, RuleInput, STAFF_AUDIENCES, type Trigger, TRIGGERS } from './engine.js';
import { RulesService } from './rules.service.js';

const id = (v: string) => { if (!z.uuid().safeParse(v).success) throw notFound('workflow rule'); return v; };
const RulePatch = z.object({
  name: z.string().trim().min(1).max(80).optional(), conditions: z.array(Condition).max(5).optional(), actions: z.array(Action).min(1).max(4).optional(),
  active: z.boolean().optional(), version: z.number().int(),
});

@Controller('v1/workflows')
@RequireModule('workflows')
@RequirePermission('customization:manage:tenant')
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  /** What the rule editor offers: triggers with their facts, staff audiences, actions, message placeholders. */
  @Get('catalog')
  catalog() {
    return {
      triggers: (Object.keys(TRIGGERS) as Trigger[]).map((k) => ({ key: k, label: TRIGGERS[k].label, facts: Object.entries(factsFor(k)).map(([key, f]) => ({ key, ...f })) })),
      audiences: Object.entries(STAFF_AUDIENCES).map(([key, label]) => ({ key, label })),
      actions: Object.entries(ACTION_LABELS).map(([key, label]) => ({ key, label })),
      placeholders: PLACEHOLDERS,
    };
  }

  @Get('rules') list() { return this.rules.list(); }
  @Post('rules') create(@Body() body: unknown) { return this.rules.create(parse(RuleInput, body)); }
  @Patch('rules/:id') update(@Param('id') p: string, @Body() body: unknown) { return this.rules.update(id(p), parse(RulePatch, body)); }
  @Get('runs') runs() { return this.rules.runs(); }
}

/** Domain events → workflow rules (and the patients' counters). */
@Injectable()
export class WorkflowConsumers implements OnModuleInit {
  constructor(private readonly registry: ConsumerRegistry, private readonly rules: RulesService) {}
  onModuleInit() {
    const handlers = Object.fromEntries(Object.values(TRIGGERS).map((t) => [t.event, (e: any, db: any) => this.rules.onEvent(db!, e)]));
    this.registry.register({ group: 'integration.workflows', topics: [Topics.scheduling, Topics.diagnostics, Topics.patient], handlers });
  }
}
