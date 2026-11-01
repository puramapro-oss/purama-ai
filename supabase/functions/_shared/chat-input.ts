export interface ChatInputMessage { role: 'user' | 'assistant'; content: string }
export const CHAT_MAX_MESSAGE_LENGTH = 2_000;

/** Shared preflight; preserve the full conversation or report its limit. */
export function prepareChatMessages(value: unknown):
  { ok: true; messages: ChatInputMessage[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0)
    return { ok: false, error: 'Écrivez un message pour commencer.' };
  if (value.length > 20)
    return { ok: false, error: 'Cette conversation a atteint sa limite. Ouvrez une nouvelle conversation pour continuer.' };
  let total = 0;
  const messages: ChatInputMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || !['user', 'assistant'].includes(item.role)
      || typeof item.content !== 'string' || !item.content.trim())
      return { ok: false, error: 'Le format de la conversation est invalide.' };
    if (item.content.length > CHAT_MAX_MESSAGE_LENGTH)
      return { ok: false, error: 'Un message dépasse 2 000 caractères.' };
    total += item.content.length;
    if (total > 20_000)
      return { ok: false, error: 'Cette conversation est trop longue. Ouvrez une nouvelle conversation pour continuer.' };
    messages.push({ role: item.role, content: item.content });
  }
  return { ok: true, messages };
}
