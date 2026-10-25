import { Logger } from '@nestjs/common';
import { DevLlm } from './dev.js';
import { GeminiLlm } from './gemini.js';
import type { LlmClient } from './llm.js';

/** LLM_PROVIDER=gemini|dev; unset: Gemini when a key or a Vertex project is configured, otherwise dev. */
export function createLlm(): LlmClient {
  const want = process.env.LLM_PROVIDER || (process.env.GEMINI_API_KEY || process.env.GEMINI_USE_VERTEX === 'true' ? 'gemini' : 'dev');
  if (want === 'dev' && process.env.MC_DEV !== 'true') throw new Error('LLM_PROVIDER=dev is for local development only');
  const llm = want === 'gemini' ? new GeminiLlm() : new DevLlm();
  new Logger('LLM').log(`provider ${llm.name}: chat ${llm.chatModel}, embeddings ${llm.embedModel}`);
  return llm;
}
