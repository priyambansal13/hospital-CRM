import { Logger } from '@nestjs/common';

/**
 * Run a start-up task in the background until it succeeds (e.g. "for every hospital, sync X" while tenant-service
 * may still be starting). Never blocks boot; logs each failed attempt; gives up after `attempts`.
 */
export function retryInBackground(name: string, task: () => Promise<void>, opts: { attempts?: number; delayMs?: number } = {}) {
  const log = new Logger(name);
  const attempts = opts.attempts ?? 60;
  const delay = opts.delayMs ?? 5000;
  void (async () => {
    for (let i = 1; i <= attempts; i++) {
      try {
        await task();
        if (i > 1) log.log(`succeeded on attempt ${i}`);
        return;
      } catch (e) {
        log.warn(`attempt ${i}/${attempts} failed: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    log.error(`gave up after ${attempts} attempts`);
  })();
}
