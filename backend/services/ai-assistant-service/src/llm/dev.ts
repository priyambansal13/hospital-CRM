import { createHash } from 'node:crypto';
import { NO_ANSWER, parseUserTurn } from '../chat/prompts.js';
import { devAgentStep } from './dev-agent.js';
import { devSummary } from './dev-copilot.js';
import { EMBED_DIM, type GenerateRequest, type GenerateResult, type LlmClient, normalise } from './llm.js';

const STOP = new Set('a an the is are was were be to of in on at for and or what when where how which who whom can could do does did i my me we our you your it its this that there with from by as please tell about any have has get need want hospital see know go come make like also just will would should much many some'.split(' '));

/** Crude stemming, good enough for matching: visiting/visitors → visit, fasting → fast. */
export function stem(w: string) {
  const s = w.replace(/(ings|ing|ers|ors|ies|ied|ed|es|s)$/, '');
  return (s.length >= 3 ? s : w).slice(0, 6);
}
export function terms(text: string): string[] {
  return (text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w)).map(stem);
}

/**
 * Development provider (no API key): deterministic and offline, so local runs, CI and tests never call Google.
 * - embed: feature hashing of word stems and character trigrams into the same 768 dimensions (lexical, not semantic);
 * - generate: answers the way the prompt tells the model to: from the best-matching <hospital_information> entry,
 *   with its citation, or NO_ANSWER when nothing matches. It is a stand-in for wiring and safety tests, not for
 *   judging answer quality (run the evals with LLM_PROVIDER=gemini for that).
 */
export class DevLlm implements LlmClient {
  readonly name = 'dev';
  readonly chatModel = 'dev-extractive';
  readonly copilotModel = 'dev-copilot';
  readonly embedModel = 'dev-hash-768-v2';

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const usage = (out: number) => ({ input: Math.ceil(JSON.stringify(req.turns).length / 4), output: out, cached: 0 });
    if (req.purpose === 'copilot') {
      const text = JSON.stringify(devSummary(req.turns.at(-1)?.text ?? ''));
      return { text, calls: [], finishReason: 'STOP', model: this.copilotModel, usage: usage(Math.ceil(text.length / 4)) };
    }
    const step = req.tools?.length ? devAgentStep(req.turns, req.tools) : null;
    if (step && 'calls' in step) return { text: '', calls: step.calls, finishReason: 'STOP', model: this.chatModel, usage: usage(20) };
    if (step) return { text: step.text, calls: [], finishReason: 'STOP', model: this.chatModel, usage: usage(Math.ceil(step.text.length / 4)) };
    const last = req.turns.findLast((t) => t.role === 'user' && t.text)?.text ?? '';
    const { entries, question } = parseUserTurn(last);
    const q = new Set(terms(question));
    let best: { n: number; text: string; score: number } | null = null;
    for (const e of entries) {
      const title = new Set(terms(e.title));
      const body = new Set(terms(e.text));
      let score = 0;
      for (const t of q) score += (title.has(t) ? 2 : 0) + (body.has(t) ? 1 : 0);
      if (score > 0 && (!best || score > best.score)) best = { n: e.n, text: e.text, score };
    }
    const text = best
      ? `${best.text.length > 700 ? `${best.text.slice(0, 700).replace(/\s\S*$/, '')}…` : best.text} [${best.n}]`
      : `${NO_ANSWER} I don't have that information. A person from the hospital can call you back.`;
    return { text, calls: [], finishReason: 'STOP', model: this.chatModel, usage: { input: Math.ceil((req.system.length + last.length) / 4), output: Math.ceil(text.length / 4), cached: 0 } };
  }

  async embed(texts: string[], _kind?: 'query' | 'document'): Promise<number[][]> {
    return texts.map((t) => {
      const v: number[] = Array.from({ length: EMBED_DIM }, () => 0);
      const add = (f: string, w: number) => {
        const h = createHash('md5').update(f).digest();
        v[h.readUInt32BE(0) % EMBED_DIM] += (h[4] & 1 ? 1 : -1) * w;
      };
      for (const s of terms(t)) {
        add(`w:${s}`, 1);
        for (let i = 0; i + 3 <= s.length; i++) add(`c:${s.slice(i, i + 3)}`, 0.3);
      }
      return normalise(v);
    });
  }
}
