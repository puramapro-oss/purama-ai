import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useInfluencer } from './useInfluencer';

const fixture = vi.hoisted(() => ({ from: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'member' } }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: fixture.from } }));
vi.mock('sonner', () => ({ toast: { success: fixture.success, error: fixture.error } }));

let root: Root;
let client: QueryClient;
let hook: ReturnType<typeof useInfluencer>;
const profile = { id: 'profile', expires_at: '2025-12-31T12:00:00Z' };
const update = vi.fn();
const eq = vi.fn();
const select = vi.fn();
const single = vi.fn();

function Probe() { hook = useInfluencer(); return null; }

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 0, 31, 12));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } } });
  client.setQueryData(['influencer', 'member'], profile);
  client.setQueryData(['commissions', 'profile'], []);
  vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
  fixture.from.mockReturnValue({ update });
  update.mockReturnValue({ eq });
  eq.mockReturnValue({ select });
  select.mockReturnValue({ single });
  root = createRoot(document.createElement('div'));
  await act(async () => { root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>); });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  client.clear();
  vi.useRealTimers();
});

it('confirme la date réellement enregistrée à la fin du mois suivant', async () => {
  const expected = new Date(2026, 1, 28, 12).toISOString();
  single.mockResolvedValue({ data: { id: 'profile', expires_at: expected }, error: null });
  await act(async () => { await hook.regenerateLink.mutateAsync(); });
  expect(fixture.from).toHaveBeenCalledWith('influencers');
  expect(update).toHaveBeenCalledWith({ expires_at: expected });
  expect(eq).toHaveBeenCalledWith('id', 'profile');
  expect(select).toHaveBeenCalledWith('id,expires_at');
  expect(fixture.success).toHaveBeenCalledOnce();
});

it.each([
  ['écriture refusée', { data: null, error: { message: 'Mise à jour refusée' } }],
  ['aucune ligne renvoyée', { data: null, error: null }],
  ['ancienne date renvoyée', { data: profile, error: null }],
] as const)('écarte une confirmation en cas de %s', async (_case, response) => {
  eq.mockReturnValue({ select, error: response.error });
  single.mockResolvedValue(response);
  await act(async () => { await expect(hook.regenerateLink.mutateAsync()).rejects.toBeDefined(); });
  expect(fixture.success).not.toHaveBeenCalled();
  expect(fixture.error).toHaveBeenCalledOnce();
});
