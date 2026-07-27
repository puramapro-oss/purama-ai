/**
 * Consomme un stream SSE au format OpenAI-compatible produit par streamAnthropicChat
 * (supabase/functions/_shared/anthropic-stream.ts) : `data: {"choices":[{"delta":{"content":"..."}}]}`.
 * Appelle `onDelta` avec le texte accumulé à chaque chunk reçu, et retourne le texte final complet.
 */
export async function parseSSEStream(response: Response, onDelta: (full: string) => void): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Réponse invalide du serveur');

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          content += delta;
          onDelta(content);
        }
      } catch {
        // ligne SSE incomplète — ignorée
      }
    }
  }

  return content;
}
