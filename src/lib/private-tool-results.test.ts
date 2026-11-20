import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ auth: { getSession: vi.fn() }, from: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: client }));

import { deletePrivateToolResult, listPrivateToolResults, parsePrivateToolResult, privateToolSourceUrl } from './private-tool-results';

const OWNER = '81000000-0000-4000-8000-000000000001';
const AGENT = '82000000-0000-4000-8000-000000000001';
const RESULT = '83000000-0000-4000-8000-000000000001';
const RUN = '84000000-0000-4000-8000-000000000001';
const OTHER = '85000000-0000-4000-8000-000000000001';
const at = '2026-11-12T10:00:00.000Z';
const source = { source: 'crossref', native_id: '10.1234/reference', label: 'Une référence', url: 'https://doi.org/10.1234/reference', retrieved_at: at };
const row = {
  id: RESULT, run_id: RUN, creator_agent_id: AGENT, user_id: OWNER,
  operation_id: 'private-operation', tool_name: 'knowledge_search', created_at: at,
  payload: {
    schema_version: 1, tool_name: 'knowledge_search', status: 'complete',
    summary: 'Une référence trouvée.', sources: [source], details: { private_data: 'not needed by the UI' },
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function queryResult(result: { data: unknown; error: unknown } | Promise<{ data: unknown; error: unknown }>) {
  const promise = Promise.resolve(result);
  const query = {
    then: promise.then.bind(promise),
    select: vi.fn(() => query), eq: vi.fn(() => query), order: vi.fn(() => query),
    limit: vi.fn(() => query), setHeader: vi.fn(() => query),
    abortSignal: vi.fn((signal: AbortSignal) => { void signal; return query; }),
    delete: vi.fn(() => query),
  };
  return query;
}

beforeEach(() => {
  vi.resetAllMocks();
  client.auth.getSession.mockResolvedValue({ data: { session: { user: { id: OWNER }, access_token: 'owner-token' } }, error: null });
});
afterEach(() => { vi.useRealTimers(); });

describe('lecture et suppression privées des résultats de mission', () => {
  it('lie la lecture au propriétaire, à l’agent et au bearer capturé ; ne garde que la projection utile', async () => {
    const query = queryResult({ data: [{ ...row, secret: 'discard' }], error: null });
    client.from.mockReturnValue(query);
    const result = await listPrivateToolResults(OWNER, AGENT);
    expect(client.from).toHaveBeenCalledWith('karta_tool_results');
    expect(query.eq.mock.calls).toEqual([['user_id', OWNER], ['creator_agent_id', AGENT]]);
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(query.limit).toHaveBeenCalledWith(20);
    expect(query.setHeader).toHaveBeenCalledWith('Authorization', 'Bearer owner-token');
    expect(query.abortSignal.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    expect(query.abortSignal.mock.calls[0][0].aborted).toBe(true);
    expect(result[0].payload.sources).toEqual([source]);
    expect(result[0]).not.toHaveProperty('secret');
    expect(result[0]).not.toHaveProperty('operation_id');
    expect(result[0].payload).not.toHaveProperty('details');
  });

  it('n’ouvre pas de requête pour un identifiant invalide ou une session qui a changé', async () => {
    await expect(listPrivateToolResults('invalid', AGENT)).rejects.toThrow('invalide');
    await expect(deletePrivateToolResult(OWNER, AGENT, 'invalid')).rejects.toThrow('invalide');
    expect(client.auth.getSession).not.toHaveBeenCalled();
    client.auth.getSession.mockResolvedValue({ data: { session: { user: { id: OTHER }, access_token: 'other-token' } }, error: null });
    await expect(listPrivateToolResults(OWNER, AGENT)).rejects.toThrow('compte actif');
    expect(client.from).not.toHaveBeenCalled();
  });

  it.each([
    { ...row, user_id: OTHER },
    { ...row, creator_agent_id: OTHER },
    { ...row, run_id: 'not-a-run' },
    { ...row, payload: { ...row.payload, schema_version: 2 } },
    { ...row, payload: { ...row.payload, status: { toString: () => 'complete' } } },
    { ...row, payload: { ...row.payload, summary: 'x'.repeat(4_001) } },
    { ...row, payload: { ...row.payload, sources: Array(11).fill(source) } },
    { ...row, payload: { ...row.payload, sources: [{ ...source, label: 'x'.repeat(257) }] } },
    { ...row, payload: { ...row.payload, sources: [{ ...source, url: 'https://example.org/private' }] } },
    { ...row, payload: { ...row.payload, sources: [{ ...source, url: 'javascript:alert(1)' }] } },
    { ...row, tool_name: 'quantum_simulate', payload: { ...row.payload, tool_name: 'quantum_simulate' } },
  ])('refuse les lignes hors contexte ou non conformes (%#)', async invalid => {
    expect(parsePrivateToolResult(invalid, OWNER, AGENT)).toBeNull();
    client.from.mockReturnValue(queryResult({ data: [invalid], error: null }));
    await expect(listPrivateToolResults(OWNER, AGENT)).rejects.toThrow('temporairement indisponibles');
  });

  it('refuse les doublons et ne laisse pas une erreur de base exposer son contenu', async () => {
    client.from.mockReturnValueOnce(queryResult({ data: [row, row], error: null }));
    await expect(listPrivateToolResults(OWNER, AGENT)).rejects.toThrow('temporairement indisponibles');
    client.from.mockReturnValueOnce(queryResult({ data: null, error: { message: 'secret from database' } }));
    await expect(listPrivateToolResults(OWNER, AGENT)).rejects.toThrow('temporairement indisponibles');
  });

  it('construit uniquement des liens HTTPS vers les références natives connues', () => {
    expect(privateToolSourceUrl({ source: 'wikidata', native_id: 'Q42' })).toBe('https://www.wikidata.org/wiki/Q42');
    expect(privateToolSourceUrl({ source: 'crossref', native_id: '10.1234/A(B)' })).toBe('https://doi.org/10.1234/a(b)');
    for (const invalid of [
      { source: 'wikidata', native_id: 'Q42?x=1' },
      { source: 'wikidata', native_id: 'Q0' },
      { source: 'unknown', native_id: '10.1234/a' },
      { source: 'crossref', native_id: '10.1234/a\nb' },
      { source: 'crossref', native_id: '10.1234/\ud800' },
    ]) expect(privateToolSourceUrl(invalid)).toBeNull();
  });

  it('accepte la simulation locale sans références et les résultats vides sans les transformer en succès', () => {
    const result = parsePrivateToolResult({ ...row, tool_name: 'quantum_simulate', payload: {
      ...row.payload, tool_name: 'quantum_simulate', status: 'empty', sources: [], summary: 'Simulation locale sans QPU.',
    } }, OWNER, AGENT);
    expect(result?.payload.status).toBe('empty');
    expect(result?.payload.sources).toEqual([]);
  });

  it('annule avant toute lecture si le signal est déjà périmé', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(listPrivateToolResults(OWNER, AGENT, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.auth.getSession).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });

  it('ne poursuit pas une authentification tardive après expiration du délai total', async () => {
    vi.useFakeTimers();
    const pending = deferred<Awaited<ReturnType<typeof client.auth.getSession>>>();
    client.auth.getSession.mockReturnValueOnce(pending.promise);
    const result = listPrivateToolResults(OWNER, AGENT);
    const rejected = expect(result).rejects.toMatchObject({ name: 'RequestDeadlineError' });
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    pending.resolve({ data: { session: { user: { id: OWNER }, access_token: 'late-token' } }, error: null });
    await Promise.resolve(); await Promise.resolve();
    expect(client.from).not.toHaveBeenCalled();
  });

  it('interrompt l’attente même si le transport ignore son signal', async () => {
    const pending = deferred<{ data: unknown; error: unknown }>();
    const query = queryResult(pending.promise);
    client.from.mockReturnValue(query);
    const abort = new AbortController();
    const result = listPrivateToolResults(OWNER, AGENT, abort.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); await Promise.resolve();
    abort.abort();
    await rejected;
    expect(query.abortSignal.mock.calls[0][0].aborted).toBe(true);
    pending.resolve({ data: [row], error: null });
  });

  it('confirme une suppression seulement pour l’ID demandé et garde tous les filtres propriétaires', async () => {
    const query = queryResult({ data: [{ id: RESULT }], error: null });
    client.from.mockReturnValue(query);
    await expect(deletePrivateToolResult(OWNER, AGENT, RESULT)).resolves.toBeUndefined();
    expect(query.delete).toHaveBeenCalledOnce();
    expect(query.eq.mock.calls).toEqual([['id', RESULT], ['user_id', OWNER], ['creator_agent_id', AGENT]]);
    expect(query.select).toHaveBeenCalledWith('id');
    expect(query.setHeader).toHaveBeenCalledWith('Authorization', 'Bearer owner-token');
  });

  it.each([{ data: [] }, { data: [{ id: OTHER }] }, { data: [{ id: RESULT }, { id: RESULT }] }, { data: null }])(
    'garde une suppression non confirmée en erreur, notamment pendant une opération (%#)', async ({ data }) => {
      client.from.mockReturnValue(queryResult({ data, error: null }));
      await expect(deletePrivateToolResult(OWNER, AGENT, RESULT)).rejects.toThrow('mission est encore en cours');
    },
  );
});
