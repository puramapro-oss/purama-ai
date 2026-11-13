import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: client }));
import { getAgent, parseCreatorExecutionPreferences, updateAgent, type CreatorAgent } from './creator-agent';

const ID = '81000000-0000-4000-8000-000000000001';
const saved = { reflection: 'deep', speed: 'fast' } as const;
function database(data: unknown, error: unknown = null) {
  const query = {
    select: vi.fn(() => query), eq: vi.fn(() => query), update: vi.fn((_patch: Record<string, unknown>) => query),
    single: vi.fn(async () => ({ data, error })),
  };
  client.from.mockReturnValue(query);
  return query;
}
beforeEach(() => vi.resetAllMocks());

describe('saved creator task preferences', () => {
  it('loads a saved profile without altering the existing model', async () => {
    const row = { id: ID, model: 'claude-sonnet-4-20250514', execution_preferences: saved };
    const query = database(row);
    const loaded = await getAgent(ID);
    expect(loaded).toEqual(row);
    expect(loaded.execution_preferences).not.toBe(saved);
    expect(query.eq).toHaveBeenCalledWith('id', ID);
  });

  it('leaves a legacy response without the column unchanged', async () => {
    database({ id: ID, model: 'legacy-model' });
    expect(await getAgent(ID)).not.toHaveProperty('execution_preferences');
  });

  it('saves exactly the chosen profile while preserving protected ownership fields', async () => {
    const query = database({ id: ID, execution_preferences: saved });
    await updateAgent(ID, { id: 'spoof', user_id: 'spoof', is_template: true, execution_preferences: saved });
    expect(query.update).toHaveBeenCalledExactlyOnceWith({ execution_preferences: saved });
    expect(query.update.mock.calls[0][0].execution_preferences).not.toBe(saved);
    expect(query.eq).toHaveBeenCalledWith('id', ID);
  });

  it('does not inject preferences into unrelated legacy edits', async () => {
    const query = database({ id: ID, name: 'Nouveau nom' });
    await updateAgent(ID, { name: 'Nouveau nom' });
    expect(query.update).toHaveBeenCalledExactlyOnceWith({ name: 'Nouveau nom' });
  });

  it.each([
    { label: 'null', value: null },
    { label: 'undefined present', value: undefined },
    { label: 'array', value: [] },
    { label: 'empty', value: {} },
    { label: 'missing reflection', value: { speed: 'fast' } },
    { label: 'missing speed', value: { reflection: 'deep' } },
    { label: 'null reflection', value: { reflection: null, speed: 'fast' } },
    { label: 'null speed', value: { reflection: 'deep', speed: null } },
    { label: 'unknown reflection', value: { reflection: 'unlimited', speed: 'fast' } },
    { label: 'unknown speed', value: { reflection: 'deep', speed: 'instant' } },
    { label: 'number', value: { reflection: 1, speed: 'fast' } },
    { label: 'extra model', value: { ...saved, model: 'other-provider' } },
    { label: 'hidden field', value: Object.defineProperty({ ...saved }, 'extra', { value: true }) },
    { label: 'accessor', value: { get reflection() { throw new Error('must not run'); }, speed: 'fast' } },
  ])('rejects $label on load and before any write', async ({ value }) => {
    database({ id: ID, execution_preferences: value });
    await expect(getAgent(ID)).rejects.toThrow('réglages');
    client.from.mockClear();
    await expect(updateAgent(ID, { execution_preferences: value } as Partial<CreatorAgent>)).rejects.toThrow('réglages');
    expect(client.from).not.toHaveBeenCalled();
  });

  it('accepts every supported reflection and speed combination', () => {
    for (const reflection of ['auto', 'standard', 'deep', 'maximum']) {
      for (const speed of ['standard', 'fast', 'ultra_fast']) {
        expect(parseCreatorExecutionPreferences({ reflection, speed })).toEqual({ reflection, speed });
      }
    }
  });

  it('does not report a successful save with a malformed returned profile', async () => {
    database({ id: ID, execution_preferences: null });
    await expect(updateAgent(ID, { execution_preferences: saved })).rejects.toThrow('réglages');
  });

  it('propagates server rejection without retry or fallback', async () => {
    const failure = { code: '42501', message: 'Row access denied' };
    const query = database(null, failure);
    await expect(updateAgent(ID, { execution_preferences: saved })).rejects.toEqual(failure);
    expect(query.single).toHaveBeenCalledOnce();
  });
});
