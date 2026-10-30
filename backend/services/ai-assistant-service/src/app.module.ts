import { Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { InternalPurgeController } from './purge.controller.js';
import { CoreModule, FieldCrypto, ModuleHooks, PLACEMENTS, retryInBackground } from '@mc/nest-common';
import { EntitlementsClient, EntitlementsModule } from '@mc/entitlements-sdk';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { ChatController, HandoffsController, KnowledgeController } from './chat/chat.controller.js';
import { ChatService } from './chat/chat.service.js';
import { KbService } from './kb/kb.service.js';
import { LLM } from './llm/llm.js';
import { createLlm } from './llm/provider.js';

/**
 * A hospital that gets the AI module (new or upgraded) gets the default knowledge from the module's enable hook
 * (manifest `lifecycle`); hospitals that already had it are checked on start. Test preparation follows the lab
 * catalog every 30 minutes (and on start). Hospitals without the module are skipped: no embeddings are paid for.
 */
@Injectable()
class KnowledgeJobs implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('KnowledgeJobs');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly hooks: ModuleHooks, private readonly kb: KbService, private readonly db: TenantDbRouter,
    @Inject(PLACEMENTS) private readonly placements: PlacementSource, private readonly entitlements: EntitlementsClient,
  ) {}

  onModuleInit() {
    this.hooks.register('ai', {
      enable: async (c) => {
        await this.kb.prepare(c);
        const t = TenantContext.require();
        void this.kb.syncTestPrep(t).catch((e) => this.log.warn(`${t.slug}: test preparation: ${(e as Error).message}`));
      },
    });
  }

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true') return;
    retryInBackground('KnowledgeSetup', () => this.all(true));
    this.timer = setInterval(() => void this.all(false).catch((e) => this.log.warn((e as Error).message)), Number(process.env.ASSISTANT_KB_SYNC_MS ?? 30 * 60_000));
  }
  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  private async all(prepare: boolean) {
    for (const t of await this.placements.list()) {
      if (t.status !== 'ACTIVE' || (await this.entitlements.moduleState(t.id, 'ai')) !== 'ACTIVE') continue;
      await TenantContext.run(t, async () => {
        if (prepare) await this.db.tx((c) => this.kb.prepare(c));
        await this.kb.syncTestPrep(t);
      }).catch((e) => this.log.warn(`${t.slug}: ${(e as Error).message}`));
    }
  }
}

@Module({
  imports: [CoreModule.forRoot({ schema: 'assistant', control: true, tenant: true, relay: false }), EntitlementsModule],
  controllers: [InternalPurgeController, ChatController, HandoffsController, KnowledgeController],
  providers: [{ provide: LLM, useFactory: createLlm }, FieldCrypto, KbService, ChatService, KnowledgeJobs],
})
export class AppModule {}
