import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { SignupService } from './signup.service.js';

/**
 * Settles provisioning signups every 30 seconds, so the owner gets the "ready" e-mail and MediCare support hears
 * about a failed signup even when nobody has the status page open. One replica runs it (the moves are idempotent anyway).
 */
@Injectable()
export class SignupSweepJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('SignupSweep');
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly signups: SignupService) {}

  onApplicationBootstrap() {
    if (process.env.MC_DISABLE_JOBS === 'true' || Number(process.env.REPLICA_INDEX ?? 0) !== 0) return;
    this.timer = setInterval(() => void this.runOnce(), Number(process.env.SIGNUP_SWEEP_MS ?? 30_000));
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  async runOnce() {
    if (this.running) return;
    this.running = true;
    try {
      for (const s of await this.signups.inProgress()) {
        await this.signups.settle(s).catch((e) => this.log.warn(`${s.slug}: ${(e as Error).message}`));
      }
    } catch (e) {
      this.log.warn(`sweep failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
