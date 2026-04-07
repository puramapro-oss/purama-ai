// Universal Agent Chat client (Email / Compta / Partner)
import { supabase } from '@/integrations/supabase/client';

export type AgentChatType = 'email' | 'compta' | 'partner';

export interface AgentChatMessage {
  id: string;
  user_id: string;
  agent_type: AgentChatType;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokens: number | null;
  created_at: string;
}

type AnyTable = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const sb = () => (supabase as unknown as { from: (t: string) => AnyTable });

export function newAgentSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function listAgentChatMessages(
  userId: string,
  agentType: AgentChatType,
  sessionId: string,
): Promise<AgentChatMessage[]> {
  const { data, error } = await sb()
    .from('agent_chat_history')
    .select('*')
    .eq('user_id', userId)
    .eq('agent_type', agentType)
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as AgentChatMessage[];
}

export async function listAgentChatSessions(
  userId: string,
  agentType: AgentChatType,
): Promise<Array<{ session_id: string; title: string; created_at: string }>> {
  const { data, error } = await sb()
    .from('agent_chat_history')
    .select('session_id, content, created_at')
    .eq('user_id', userId)
    .eq('agent_type', agentType)
    .eq('role', 'user')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  const map = new Map<string, { session_id: string; title: string; created_at: string }>();
  for (const row of (data ?? []) as Array<{ session_id: string; content: string; created_at: string }>) {
    if (!map.has(row.session_id)) {
      map.set(row.session_id, {
        session_id: row.session_id,
        title: row.content.slice(0, 60),
        created_at: row.created_at,
      });
    }
  }
  return [...map.values()];
}

export async function sendAgentChatMessage(
  agentType: AgentChatType,
  sessionId: string,
  message: string,
): Promise<{ reply: string; tokens: number | null }> {
  const { data, error } = await supabase.functions.invoke('agent-chat', {
    body: { agent_type: agentType, session_id: sessionId, message },
  });
  if (error) throw error;
  return data as { reply: string; tokens: number | null };
}
