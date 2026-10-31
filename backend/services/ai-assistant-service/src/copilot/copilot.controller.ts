import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { CurrentActor, notFound, parse } from '@mc/nest-common';
import type { Actor } from '@mc/tenancy';
import { z } from 'zod';
import { CopilotService } from './copilot.service.js';

const id = (v: string, what: string) => { if (!z.uuid().safeParse(v).success) throw notFound(what); return v; };
const Feedback = z.object({ rating: z.union([z.literal(1), z.literal(-1)]), reason: z.enum(['WRONG', 'MISSING', 'NOT_USEFUL', 'TOO_LONG', 'OTHER']).nullable().optional(), comment: z.string().trim().max(500).nullable().optional() });

/** The doctor's copilot: a pre-visit summary per appointment, every line citing its record (a draft, never the record). */
@Controller('v1/assistant/copilot')
@RequireModule('ai')
@RequirePermission('copilot:use:own')
export class CopilotController {
  constructor(private readonly copilot: CopilotService) {}

  @Get('appointments/:appointmentId/summary')
  async latest(@Param('appointmentId') a: string, @CurrentActor() actor: Actor) {
    return { summary: await this.copilot.latest(actor, id(a, 'appointment')) };
  }

  @Post('appointments/:appointmentId/summary')
  @HttpCode(200)
  async generate(@Param('appointmentId') a: string, @CurrentActor() actor: Actor) {
    return { summary: await this.copilot.generate(actor, id(a, 'appointment')) };
  }

  @Post('drafts/:id/feedback')
  @HttpCode(204)
  feedback(@Param('id') d: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.copilot.feedback(actor, id(d, 'summary'), parse(Feedback, body));
  }
}
