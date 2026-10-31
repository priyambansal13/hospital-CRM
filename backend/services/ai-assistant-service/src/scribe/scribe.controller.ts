import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { CurrentActor, notFound, parse } from '@mc/nest-common';
import type { Actor } from '@mc/tenancy';
import { z } from 'zod';
import { ScribeService } from './scribe.service.js';

const id = (v: string, what: string) => { if (!z.uuid().safeParse(v).success) throw notFound(what); return v; };
const Draft = z.object({ recordingId: z.uuid() });
const Apply = z.object({ final: z.record(z.string(), z.unknown()) });

/** The AI scribe: a recorded visit (with consent) → a SOAP draft the doctor takes over, edits and signs. */
@Controller('v1/assistant/scribe')
@RequireModule('ai')
@RequirePermission('copilot:use:own')
export class ScribeController {
  constructor(private readonly scribe: ScribeService) {}

  @Post('encounters/:encounterId/drafts')
  @HttpCode(200)
  async draft(@Param('encounterId') e: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return { draft: await this.scribe.draft(actor, id(e, 'encounter'), parse(Draft, body).recordingId) };
  }

  @Get('encounters/:encounterId/draft')
  async latest(@Param('encounterId') e: string, @CurrentActor() actor: Actor) {
    return { draft: await this.scribe.latest(actor, id(e, 'encounter')) };
  }

  @Post('drafts/:id/apply')
  @HttpCode(200)
  async apply(@Param('id') d: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return { draft: await this.scribe.apply(actor, id(d, 'draft'), parse(Apply, body).final) };
  }
}
