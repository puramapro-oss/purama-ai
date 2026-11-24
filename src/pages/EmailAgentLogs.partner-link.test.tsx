import { act, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import EmailAgentLogs from './EmailAgentLogs';

const f = vi.hoisted(() => ({ user: { id: '' } as { id: string } | null, list: vi.fn(), get: vi.fn(), preview: vi.fn(), send: vi.fn(), approve: vi.fn() }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: f.user }) }));
vi.mock('@/lib/email-agent', () => ({ listLogs: f.list, getEmailAgentLog: f.get, getDraftPreview: f.preview,
  sendDraft: f.send, approveLog: f.approve, rejectLog: vi.fn(), reconcileDraft: vi.fn(),
  ACTION_META: {}, CATEGORY_META: {} }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('framer-motion', async () => { const React = await import('react'); return {
  motion: { div: React.forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { initial?: unknown; animate?: unknown }>((props, ref) => {
    const p = { ...props }; delete p.initial; delete p.animate; return React.createElement('div', { ...p, ref });
  }) },
}; });
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const item = { id, user_id: owner, subject: 'Réponse partenaire privée', from_email: 'fixture@example.invalid',
  action_taken: 'draft', user_approved: null, created_at: '2026-11-24T12:00:00Z', body_preview: 'Question originale', ai_response: 'Brouillon' };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
let root: Root; let host: HTMLDivElement;
const render = (path = `/dashboard/email-agent/logs?log=${id}`) => act(async () => root.render(<MemoryRouter initialEntries={[path]}><EmailAgentLogs /></MemoryRouter>));
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); f.user = { id: owner };
  for (const fn of [f.list, f.get, f.preview, f.send, f.approve]) fn.mockReset();
  f.list.mockResolvedValue([]); f.get.mockResolvedValue(item); f.preview.mockRejectedValue(new Error('Aperçu indisponible'));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
describe('direct partner draft access', () => {
  it('loads an older log outside the latest page and requires approval before any send', async () => {
    await render(); expect(f.get).toHaveBeenCalledWith(owner, id, expect.any(AbortSignal));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Réponse partenaire privée');
    expect(f.preview).toHaveBeenCalledWith(owner, id, expect.any(AbortSignal));
    expect(f.send).not.toHaveBeenCalled(); expect(f.approve).not.toHaveBeenCalled();
  });
  it('shows absence honestly without fabricating a draft', async () => {
    f.get.mockResolvedValue(null); await render(); expect(host.textContent).toContain('n’est pas accessible');
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(f.preview).not.toHaveBeenCalled();
  });
  it('does not query an invalid link', async () => {
    await render('/dashboard/email-agent/logs?log=invalid'); expect(f.get).not.toHaveBeenCalled();
    expect(host.textContent).toContain('lien vers ce brouillon est invalide');
  });
  it('allows a targeted retry after a read failure', async () => {
    f.get.mockRejectedValueOnce(new Error('network')); await render();
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Réessayer ce brouillon')!;
    await act(async () => retry.click()); expect(f.get).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Réponse partenaire privée');
  });
  it('ignores a response from an old account even after returning to it', async () => {
    const wait = deferred<typeof item>(); f.get.mockReturnValueOnce(wait.promise); await render();
    f.get.mockResolvedValue(null); f.user = { id: other }; await render(); f.user = { id: owner }; await render();
    await act(async () => wait.resolve(item)); expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(f.preview).not.toHaveBeenCalled();
  });
});
