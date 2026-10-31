/**
 * The only way this service talks to a model (docs/AI-AGENTS.md §3 "Provider port"). Switching AI Studio ↔ Vertex AI,
 * or to the dev provider, is configuration: LLM_PROVIDER=gemini|dev (default: gemini when GEMINI_API_KEY or
 * GOOGLE_CLOUD_PROJECT is set, else dev). Model ids live in env, never in code paths.
 */
export interface ToolCall { id?: string; name: string; args: Record<string, unknown> }
export interface ToolResult { id?: string; name: string; response: Record<string, unknown> }
/** A tool the model may call (JSON Schema parameters, as Gemini's `parametersJsonSchema`). */
export interface ToolDecl { name: string; description: string; parameters: Record<string, unknown> }

/**
 * One turn. Plain text, a model turn that calls tools, or a user turn carrying the tools' results. `raw` is the
 * provider's own content for a model turn (Gemini: with thought signatures, which multi-step tool use needs back).
 */
export interface Turn { role: 'user' | 'model'; text?: string; calls?: ToolCall[]; results?: ToolResult[]; raw?: unknown }

export interface GenerateRequest {
  system: string;
  turns: Turn[];
  tools?: ToolDecl[];
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
  /** tools the model wants run (then call generate again with the results) */
  calls: ToolCall[];
  /** the model turn as the provider returned it, to send back unchanged */
  raw?: unknown;
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
