/**
 * The only way this service talks to a model (docs/AI-AGENTS.md §3 "Provider port"). Switching AI Studio ↔ Vertex AI,
 * or to the dev provider, is configuration: LLM_PROVIDER=gemini|dev (default: gemini when GEMINI_API_KEY or
 * GOOGLE_CLOUD_PROJECT is set, else dev). Model ids live in env, never in code paths.
 */
export interface Turn { role: 'user' | 'model'; text: string }

export interface GenerateRequest {
  system: string;
  turns: Turn[];
  /** low for chat, high for clinical drafting */
  thinking?: 'minimal' | 'low' | 'medium' | 'high';
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface GenerateResult {
  text: string;
  /** STOP, MAX_TOKENS, SAFETY, BLOCKED (prompt blocked), ERROR … */
  finishReason: string;
  model: string;
  usage: { input: number; output: number; cached: number };
}

export interface LlmClient {
  readonly name: string;
  readonly chatModel: string;
  readonly embedModel: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  /** Unit-length vectors of EMBED_DIM numbers; `kind` lets providers optimise for queries vs documents. */
  embed(texts: string[], kind: 'query' | 'document'): Promise<number[][]>;
}

export const LLM = Symbol('LLM');
export const EMBED_DIM = 768;

export function normalise(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}
