import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { AdminAudited, CurrentActor, notFound, parse } from '@mc/nest-common';
import type { Actor } from '@mc/tenancy';
import { z } from 'zod';
import { KbService } from '../kb/kb.service.js';
import { ChatService } from './chat.service.js';

const id = (v: string, what: string) => { if (!z.uuid().safeParse(v).success) throw notFound(what); return v; };
const Send = z.object({ conversationId: z.uuid().optional(), text: z.string().min(1).max(1000) });
const Handoff = z.object({ reason: z.enum(['ASKED', 'NO_ANSWER', 'EMERGENCY', 'LIMIT', 'FALLBACK']).default('ASKED'), phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'a phone number').nullable().optional() });
const Feedback = z.object({ rating: z.union([z.literal(1), z.literal(-1)]), reason: z.enum(['WRONG', 'UNHELPFUL', 'UNSAFE', 'OTHER']).nullable().optional() });
const Close = z.object({ note: z.string().trim().max(500).nullable().optional() });
const Article = z.object({ source: z.enum(['FAQ', 'POLICY']), title: z.string().trim().min(2).max(200), body: z.string().trim().min(2).max(8000), language: z.enum(['en', 'hi']).default('en') });
const ArticlePatch = z.object({ title: z.string().trim().min(2).max(200).optional(), body: z.string().trim().min(2).max(8000).optional(), active: z.boolean().optional(), version: z.number().int() });

/** The patient's chat (docs/AI-AGENTS.md §4). Signed-in patients only; each sees only their own conversations. */
@Controller('v1/assistant')
@RequireModule('ai')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post('messages')
  @RequirePermission('assistant:chat:own')
  @HttpCode(200)
  send(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.chat.send(actor, parse(Send, body));
  }

  @Get('conversations/latest')
  @RequirePermission('assistant:chat:own')
  latest(@CurrentActor() actor: Actor) {
    return this.chat.latest(actor);
  }

  @Get('conversations/:id/messages')
  @RequirePermission('assistant:chat:own')
  async messages(@Param('id') cid: string, @CurrentActor() actor: Actor) {
    await this.chat.own(actor, id(cid, 'conversation'));
    return this.chat.messages(cid);
  }

  @Post('conversations/:id/close')
  @RequirePermission('assistant:chat:own')
  @HttpCode(204)
  close(@Param('id') cid: string, @CurrentActor() actor: Actor) {
    return this.chat.close(actor, id(cid, 'conversation'));
  }

  @Post('conversations/:id/handoff')
  @RequirePermission('assistant:chat:own')
  @HttpCode(200)
  handoff(@Param('id') cid: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.chat.handoff(actor, id(cid, 'conversation'), parse(Handoff, body ?? {}));
  }

  @Post('messages/:id/feedback')
  @RequirePermission('assistant:chat:own')
  @HttpCode(204)
  feedback(@Param('id') mid: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.chat.feedback(actor, id(mid, 'message'), parse(Feedback, body));
  }
}

/** Front desk: chats handed to a person (call the patient back, then close). */
@Controller('v1/assistant/handoffs')
@RequireModule('ai')
@RequirePermission('assistant_handoff:manage:branch')
export class HandoffsController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  list(@Query('status') status?: string) {
    return this.chat.handoffs(status === 'DONE' ? 'DONE' : 'OPEN');
  }

  @Get('summary')
  summary() {
    return this.chat.handoffSummary();
  }

  @Post(':id/close')
  @HttpCode(200)
  close(@Param('id') hid: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.chat.closeHandoff(actor.id, id(hid, 'chat request'), parse(Close, body ?? {}).note ?? null);
  }
}

/** Admin: what the assistant knows. Test preparation is read-only here (it comes from the lab catalog). */
@Controller('v1/assistant/knowledge')
@RequireModule('ai')
@AdminAudited('KNOWLEDGE')
@RequirePermission('knowledge:manage:tenant')
export class KnowledgeController {
  constructor(private readonly kb: KbService) {}

  @Get()
  list() {
    return this.kb.list();
  }

  /** "Try a question": what the assistant would find for it (no model call, nothing stored). */
  @Get('search')
  async search(@Query('q') q?: string) {
    const query = parse(z.string().trim().min(2).max(300), q ?? '');
    return { query, hits: await this.kb.search(query) };
  }

  @Post()
  create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.kb.create(parse(Article, body), actor.id);
  }

  @Put(':id')
  update(@Param('id') aid: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.kb.update(id(aid, 'article'), parse(ArticlePatch, body), actor.id);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') aid: string) {
    return this.kb.remove(id(aid, 'article'));
  }
}
