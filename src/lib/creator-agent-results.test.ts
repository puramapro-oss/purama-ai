import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ functions: { invoke: vi.fn() } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: client }));

import { chatWithAgent } from './creator-agent';

const AGENT = '82000000-0000-4000-8000-000000000001';
const SESSION = '82000000-0000-4000-8000-000000000002';
const RESULTS = Array.from({ length: 4 }, (_, index) => `83000000-0000-4000-8000-00000000000${index + 1}`);

beforeEach(() => {
  vi.resetAllMocks();
  client.functions.invoke.mockResolvedValue({ data: { reply: 'Réponse', tokens: 12 }, error: null });
});

describe('références privées jointes au chat existant', () => {
  it('conserve exactement le corps historique quand aucune référence n’est choisie', async () => {
    const signal = new AbortController().signal;
    await expect(chatWithAgent(AGENT, SESSION, 'Bonjour', signal)).resolves.toEqual({ reply: 'Réponse', tokens: 12 });
    expect(client.functions.invoke).toHaveBeenCalledExactlyOnceWith('creator-agent-chat', {
      body: { agent_id: AGENT, session_id: SESSION, message: 'Bonjour' }, signal,
    });
  });

  it('transmet uniquement une copie des identifiants choisis, sans contenu ni appel supplémentaire', async () => {
    const signal = new AbortController().signal;
    const ids = RESULTS.slice(0, 3);
    const response = chatWithAgent(AGENT, SESSION, 'Comparer les résultats', signal, ids);
    ids.pop();
    await response;
    expect(client.functions.invoke).toHaveBeenCalledExactlyOnceWith('creator-agent-chat', {
      body: { agent_id: AGENT, session_id: SESSION, message: 'Comparer les résultats', tool_result_ids: RESULTS.slice(0, 3) }, signal,
    });
  });

  it.each([
    { ids: RESULTS },
    { ids: [RESULTS[0], RESULTS[0]] },
    { ids: ['83000000-0000-4000-8000-abcdefabcdef', '83000000-0000-4000-8000-ABCDEFABCDEF'] },
    { ids: ['not-an-id'] },
  ])('refuse les sélections invalides avant un appel réseau (%#)', async ({ ids }) => {
    await expect(chatWithAgent(AGENT, SESSION, 'Question', undefined, ids)).rejects.toThrow('trois résultats privés distincts');
    expect(client.functions.invoke).not.toHaveBeenCalled();
  });

  it('ignore une réponse de chat qui arrive après annulation', async () => {
    let resolve!: (value: unknown) => void;
    client.functions.invoke.mockReturnValue(new Promise(accept => { resolve = accept; }));
    const abort = new AbortController();
    const pending = chatWithAgent(AGENT, SESSION, 'Question', abort.signal, [RESULTS[0]]);
    abort.abort();
    resolve({ data: { reply: 'Trop tard', tokens: 12 }, error: null });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('propage l’échec serveur sans relancer de synthèse', async () => {
    const failure = new Error('Résultat inaccessible');
    client.functions.invoke.mockResolvedValue({ data: null, error: failure });
    await expect(chatWithAgent(AGENT, SESSION, 'Question', undefined, [RESULTS[0]])).rejects.toBe(failure);
    expect(client.functions.invoke).toHaveBeenCalledOnce();
  });
});
