/**
 * Consume OpenAI-compatible SSE. A response is complete only after [DONE].
 * Never persist a partial transport response as a successful assistant message.
 */
export async function parseSSEStream(response: Response, onDelta: (full: string) => void): Promise<string> {
  if (!response.ok) throw new Error(`Erreur ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Réponse invalide du serveur');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let content = '';
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) throw new Error('Réponse interrompue avant confirmation de fin');
      buffer += decoder.decode(value, {stream: true});
      let separator: RegExpExecArray | null;
      while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
        if (separator.index > 262_144) throw new Error('Événement trop volumineux');
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = frame.split(/\r\n|\r|\n/).filter(line=>line.startsWith('data:'))
          .map(line=>line.slice(5).replace(/^ /,'')).join('\n');
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
      if (buffer.length > 262_144) throw new Error('Événement trop volumineux');
    }
  } finally {
    await reader.cancel().catch(()=>undefined);
    reader.releaseLock();
  }
}
