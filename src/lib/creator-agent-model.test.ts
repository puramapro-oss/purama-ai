import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: client }));

import { createAgent, MODELS } from './creator-agent';

const owner = '81000000-0000-4000-8000-000000000001';

beforeEach(() => vi.resetAllMocks());

describe('Creator Agent — model creation contract', () => {
  function captureInsert() {
    const insert = vi.fn((row: Record<string, unknown>) => ({
      select: () => ({ single: async () => ({ data: { id: 'created-agent', ...row }, error: null }) }),
    }));
    client.from.mockReturnValue({ insert });
    return insert;
  }

  it('persists the current default when the caller omits the model', async () => {
    const insert = captureInsert();
    const created = await createAgent(owner, { name: 'Mon agent', system_prompt: 'Aider.' });
    expect(client.from).toHaveBeenCalledExactlyOnceWith('creator_agents');
    expect(insert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      user_id: owner, model: 'claude-sonnet-4-6', is_template: false,
    }));
    expect(created.model).toBe('claude-sonnet-4-6');
  });

  it('keeps an explicit Haiku choice instead of replacing it with the default', async () => {
    captureInsert();
    const created = await createAgent(owner, {
      name: 'Mon agent rapide', system_prompt: 'Aider.', model: 'claude-haiku-4-5-20251001',
    });
    expect(created.model).toBe('claude-haiku-4-5-20251001');
  });

  it('offers the two supported choices without reintroducing the retired default', () => {
    expect(MODELS.map(({ value }) => value)).toEqual([
      'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
    ]);
  });
});
