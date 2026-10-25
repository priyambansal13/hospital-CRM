'use server';
import { actionSession } from '@mc/auth';
import { api, ApiError } from '@mc/bff';
import type { ChatMessage, Handoff } from '@mc/ai-chat';

/** The assistant chat's server actions: the patient's token never reaches the browser. */
const msg = (e: unknown) => (e instanceof ApiError ? (e.status === 429 ? 'You are sending messages too fast. Please wait a few minutes.' : e.message) : 'Something went wrong. Please try again.');

export async function sendMessage(conversationId: string | null, text: string) {
  const { accessToken: token } = await actionSession();
  try {
    return await api<{ conversationId: string; userMessageId: string; message: ChatMessage }>('/api/assistant/v1/assistant/messages', { token, body: { ...(conversationId ? { conversationId } : {}), text } });
  } catch (e) {
    return { error: msg(e) };
  }
}

export async function requestHandoff(conversationId: string, reason: string) {
  const { accessToken: token } = await actionSession();
  try {
    return await api<{ handoff: Handoff; message: ChatMessage | null }>(`/api/assistant/v1/assistant/conversations/${encodeURIComponent(conversationId)}/handoff`, { token, body: { reason } });
  } catch (e) {
    return { error: msg(e) };
  }
}

export async function rateMessage(messageId: string, rating: 1 | -1) {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/assistant/v1/assistant/messages/${encodeURIComponent(messageId)}/feedback`, { token, body: { rating } });
    return { ok: true as const };
  } catch (e) {
    return { error: msg(e) };
  }
}

export async function closeChat(conversationId: string) {
  const { accessToken: token } = await actionSession();
  try {
    await api(`/api/assistant/v1/assistant/conversations/${encodeURIComponent(conversationId)}/close`, { token, method: 'POST' });
    return { ok: true as const };
  } catch (e) {
    return { error: msg(e) };
  }
}
