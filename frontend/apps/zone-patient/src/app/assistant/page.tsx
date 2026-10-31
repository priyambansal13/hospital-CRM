import { ChatPanel, type ChatMessage, type Conversation } from '@mc/ai-chat';
import { getSession } from '@mc/auth';
import { api, getBranding } from '@mc/bff';
import { can, ZoneFrame, zoneCapabilities } from '@mc/features';
import { Alert, PageHeader } from '@mc/ui';
import { closeChat, confirmAction, rateMessage, rejectAction, requestHandoff, sendMessage } from '@/lib/assistant-actions';
import { ZONES } from '@/lib/zones';

export const dynamic = 'force-dynamic';

/** "Ask us": the hospital's AI assistant (Phase 22: questions about the hospital; Phase 23: find a doctor and book, move or cancel with Confirm cards). */
export default async function AssistantPage() {
  const caps = await zoneCapabilities('patient', '/care/assistant');
  if (caps.actor.kind !== 'patient' || !can(caps, 'assistant:chat:own')) {
    return <ZoneFrame zone="patient" path="/care/assistant" zones={ZONES}><Alert tone="error">The assistant is not available here.</Alert></ZoneFrame>;
  }
  const { accessToken: token } = (await getSession())!;
  const [branding, latest] = await Promise.all([
    getBranding(),
    api<{ conversation: Conversation | null; messages: ChatMessage[] }>('/api/assistant/v1/assistant/conversations/latest', { token }),
  ]);
  return (
    <ZoneFrame zone="patient" path="/care/assistant" zones={ZONES}>
      <PageHeader title="Ask us" subtitle="Questions about the hospital, finding a doctor, booking or changing a visit. A person is one tap away." />
      <ChatPanel hospital={branding.name} initial={latest} actions={{ send: sendMessage, handoff: requestHandoff, feedback: rateMessage, close: closeChat, confirm: confirmAction, reject: rejectAction }} />
    </ZoneFrame>
  );
}
