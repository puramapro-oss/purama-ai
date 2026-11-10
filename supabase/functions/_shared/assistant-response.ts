export type CompletedAssistantReply =
  | { ok: true; text: string }
  | { ok: false; reason: 'invalid' | 'incomplete' | 'empty' };

/** Text-only chats must not save a partial answer as a completed reply. */
export function readCompletedAssistantReply(value: unknown): CompletedAssistantReply {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'invalid' };
  const response = value as Record<string, unknown>;
  if (!['end_turn', 'stop_sequence', 'refusal'].includes(String(response.stop_reason)))
    return { ok: false, reason: 'incomplete' };
  if (!Array.isArray(response.content)) return { ok: false, reason: 'invalid' };
  const texts: string[] = [];
  for (const block of response.content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return { ok: false, reason: 'invalid' };
    if (block.type === 'text') {
      if (typeof block.text !== 'string') return { ok: false, reason: 'invalid' };
      texts.push(block.text);
    } else if (block.type !== 'thinking' && block.type !== 'redacted_thinking') {
      // These routes have no tool execution loop. Never silently drop a tool call.
      return { ok: false, reason: 'invalid' };
    }
  }
  const text = texts.join('\n');
  return text.trim() ? { ok: true, text } : { ok: false, reason: 'empty' };
}
