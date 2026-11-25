import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PartnerReplyAction } from './PartnerReplyAction';
import type { PartnerProspect } from '@/lib/partner';
import type { PartnerReplyPreparation } from '@/lib/partner-completion';

const fixture = vi.hoisted(() => ({ user: { id: '' } as { id: string } | null, prepare: vi.fn() }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: fixture.user }) }));
vi.mock('@/lib/partner-completion', async original => ({ ...await original<typeof import('@/lib/partner-completion')>(), preparePartnerReply: fixture.prepare }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const log = '44444444-4444-4444-8444-444444444444';
const prospect = { id, user_id: owner, status: 'contacted', reply_kind: 'human', reply_gmail_message_id: 'msg1', updated_at: 'v1' } as PartnerProspect;
const prepared: PartnerReplyPreparation = { status: 'prepared', log_id: log, user_id: owner, prospect_id: id, gmail_message_id: 'msg1' };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
let root: Root; let host: HTMLDivElement;
const render = (row = prospect) => act(async () => root.render(<MemoryRouter><PartnerReplyAction prospect={row} /></MemoryRouter>));
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); fixture.user = { id: owner }; fixture.prepare.mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
describe('partner reply action', () => {
  it.each(['automatic', 'refusal'] as const)('does not offer a reply for %s', async reply_kind => {
    await render({ ...prospect, reply_kind }); expect(host.querySelector('button')).toBeNull(); expect(fixture.prepare).not.toHaveBeenCalled();
  });
  it('does not reveal an action for another account', async () => {
    fixture.user = { id: other }; await render(); expect(host.textContent).toBe('');
  });
  it('deduplicates rapid clicks and opens the existing approval path', async () => {
    const wait = deferred<PartnerReplyPreparation>(); fixture.prepare.mockReturnValue(wait.promise); await render();
    expect(fixture.prepare).not.toHaveBeenCalled();
    await act(async () => { host.querySelector('button')!.click(); host.querySelector('button')!.click(); });
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
    await act(async () => wait.resolve(prepared));
    expect(host.querySelector('a')?.getAttribute('href')).toBe(`/dashboard/email-agent/logs?log=${log}`);
    expect(host.textContent).toContain('approuver son envoi');
    expect(host.textContent).not.toContain('envoyé avec succès');
  });
  it('offers the selected bounded intent', async () => {
    fixture.prepare.mockResolvedValue(prepared); await render();
    await act(async () => { const select = host.querySelector('select')!; select.value = 'share_offer'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => host.querySelector('button')!.click());
    expect(fixture.prepare.mock.calls[0].slice(0, 4)).toEqual([owner, id, 'msg1', 'share_offer']);
  });
  it.each(['blocked', 'unknown'] as const)('keeps %s results out of the approval link', async status => {
    fixture.prepare.mockResolvedValue({ status, reason: 'contact_suppressed' }); await render();
    await act(async () => host.querySelector('button')!.click());
    expect(host.querySelector('a')).toBeNull(); expect(host.querySelector('[role="status"]')).not.toBeNull();
  });
  it('ignores the old response after a newer message replaces it', async () => {
    const wait = deferred<PartnerReplyPreparation>(); fixture.prepare.mockReturnValue(wait.promise); await render();
    await act(async () => host.querySelector('button')!.click());
    await render({ ...prospect, reply_gmail_message_id: 'msg2', updated_at: 'v2' });
    await act(async () => wait.resolve(prepared));
    expect(host.querySelector('a')).toBeNull(); expect(host.querySelector('button')?.disabled).toBe(false);
  });
  it('rejects a stale result even across owner A → B → A', async () => {
    const wait = deferred<PartnerReplyPreparation>(); fixture.prepare.mockReturnValue(wait.promise); await render();
    await act(async () => host.querySelector('button')!.click());
    fixture.user = { id: other }; await render(); fixture.user = { id: owner }; await render();
    await act(async () => wait.resolve(prepared)); expect(host.querySelector('a')).toBeNull();
    expect(host.querySelector('button')?.disabled).toBe(false);
  });
  it('keeps preparation retry available after a transport error', async () => {
    fixture.prepare.mockRejectedValue(new Error('Résultat à vérifier')); await render();
    await act(async () => host.querySelector('button')!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Résultat à vérifier');
    expect(host.querySelector('button')?.disabled).toBe(false);
  });
});
