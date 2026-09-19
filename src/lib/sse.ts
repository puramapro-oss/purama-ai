import { createSSEDataParser } from '../../supabase/functions/_shared/sse-data.ts';

/**
 * Consume OpenAI-compatible SSE. A response is complete only after [DONE].
 * Never persist a partial transport response as a successful assistant message.
 */
export async function parseSSEStream(response: Response, onDelta: (full: string) => void): Promise<string> {
  if (!response.ok) throw new Error(`Erreur ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Réponse invalide du serveur');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const push = createSSEDataParser();
  let content = '';
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) throw new Error('Réponse interrompue avant confirmation de fin');
      for (const data of push(decoder.decode(value, {stream: true}))) {
        if (!data) continue;
        if (data === '[DONE]') return content;
        const parsed = JSON.parse(data);
        if (!parsed || typeof parsed !== 'object' || parsed.error) throw new Error('Erreur du flux de réponse');
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta !== undefined && delta !== null && typeof delta !== 'string') throw new Error('Contenu de réponse invalide');
        if (delta) {
          content += delta;
          if (content.length > 1_048_576) throw new Error('Réponse trop volumineuse');
          onDelta(content);
        }
      }
    }
  } finally {
    await reader.cancel().catch(()=>undefined);
    reader.releaseLock();
  }
}
