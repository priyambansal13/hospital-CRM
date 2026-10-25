import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { EMBED_DIM, type GenerateRequest, type GenerateResult, type LlmClient, normalise } from './llm.js';

const LEVEL = { minimal: ThinkingLevel.MINIMAL, low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH };

/**
 * Gemini through @google/genai. Development: an AI Studio key (GEMINI_API_KEY) with synthetic data only.
 * Real patient data: Vertex AI (GEMINI_USE_VERTEX=true, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION, e.g.
 * asia-south1) under the hospital-grade agreement; the service account's identity, no key (docs/AI-AGENTS.md §10).
 */
export class GeminiLlm implements LlmClient {
  readonly name = 'gemini';
  readonly chatModel = process.env.GEMINI_CHAT_MODEL ?? 'gemini-3.8-flash';
  readonly embedModel = process.env.GEMINI_EMBED_MODEL ?? 'gemini-embedding-2';
  private readonly ai: GoogleGenAI;

  constructor() {
    this.ai = process.env.GEMINI_USE_VERTEX === 'true'
      ? new GoogleGenAI({ vertexai: true, project: process.env.GOOGLE_CLOUD_PROJECT, location: process.env.GOOGLE_CLOUD_LOCATION ?? 'asia-south1' })
      : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const res = await this.ai.models.generateContent({
      model: this.chatModel,
      contents: req.turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
      config: {
        systemInstruction: req.system,
        thinkingConfig: { thinkingLevel: LEVEL[req.thinking ?? 'low'] },
        maxOutputTokens: req.maxOutputTokens ?? 800,
        abortSignal: AbortSignal.timeout(req.timeoutMs ?? 20_000),
      },
    });
    const c = res.candidates?.[0];
    const u = res.usageMetadata;
    return {
      text: res.promptFeedback?.blockReason ? '' : (res.text ?? ''),
      finishReason: res.promptFeedback?.blockReason ? 'BLOCKED' : String(c?.finishReason ?? 'STOP'),
      model: res.modelVersion ?? this.chatModel,
      usage: { input: u?.promptTokenCount ?? 0, output: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0), cached: u?.cachedContentTokenCount ?? 0 },
    };
  }

  async embed(texts: string[], kind: 'query' | 'document'): Promise<number[][]> {
    const res = await this.ai.models.embedContent({
      model: this.embedModel,
      contents: texts,
      config: { outputDimensionality: EMBED_DIM, taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT' },
    });
    // truncated (Matryoshka) vectors are not unit length: normalise for cosine
    return (res.embeddings ?? []).map((e) => normalise(e.values ?? []));
  }
}
