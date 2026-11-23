import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PartnerAgentChat } from './PartnerAgentChat';
import type { PartnerContractResult, PartnerProspect } from '@/lib/partner';

const fixture = vi.hoisted(() => ({
  user: { id: '11111111-1111-4111-8111-111111111111' } as { id: string } | null,
  prepare: vi.fn<(prospectId: string) => Promise<PartnerContractResult>>(),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: fixture.user }) }));
vi.mock('@/lib/partner', async () => ({
  ...(await import('@/lib/partner-contract-result')), generateContract: fixture.prepare,
}));
// The chat lifecycle is exercised with its real component in VoiceMode.accessibility.test.tsx.
vi.mock('@/components/voice/AgentChatTab', () => ({ AgentChatTab: ({ prospectId }: { prospectId?: string }) =>
  <div data-testid="chat-context">{prospectId ?? 'general'}</div> }));
const owner = '11111111-1111-4111-8111-111111111111';
const a = '22222222-2222-4222-8222-222222222222';
const b = '33333333-3333-4333-8333-333333333333';
const foreign = '44444444-4444-4444-8444-444444444444';
const prospects = [
  { id: a, user_id: owner, name: 'Partner A', status: 'interested', email: 'a@example.invalid' },
  { id: b, user_id: owner, name: 'Partner B', status: 'identified', email: 'b@example.invalid' },
  { id: foreign, user_id: foreign, name: 'Foreign secret', status: 'interested', email: 'secret@example.invalid' },
] as PartnerProspect[];
let root: Root;
let host: HTMLDivElement;
const render = () => act(async () => root.render(<MemoryRouter><PartnerAgentChat prospects={prospects} /></MemoryRouter>));
async function select(value: string) {
  await act(async () => {
    const input = host.querySelector('select')!;
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function button() { return [...host.querySelectorAll('button')].find(item => /Préparer|Préparation/.test(item.textContent!))!; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.user = { id: owner };
  fixture.prepare.mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('explicit partner action from the chat panel', () => {
  it('offers only own dossiers and performs no action on mount or selection', async () => {
    await render();
    expect(host.textContent).not.toContain('Foreign secret');
    expect(host.querySelector('label')?.htmlFor).toBe('partner-chat-prospect');
    await select(a);
    expect(host.querySelector('[data-testid="chat-context"]')?.textContent).toBe(a);
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(host.querySelector('a')?.getAttribute('href')).toBe(`/dashboard/partner-agent/prospects?contractProspect=${a}`);
    await select(b);
    expect(button().disabled).toBe(true);
  });

  it('invokes the existing prepare-only API once even for synchronous double activation', async () => {
    const pending = deferred<PartnerContractResult>(); fixture.prepare.mockReturnValue(pending.promise);
    await render(); await select(a);
    await act(async () => { button().click(); button().click(); });
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.prepare).toHaveBeenCalledWith(a);
    expect(button().disabled).toBe(true);
    await act(async () => pending.resolve({ status: 'unknown', reused: true, reason: 'reconciliation_required' }));
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Envoi du contrat à vérifier');
    expect(host.querySelector('[role="status"]')?.textContent).not.toContain('Contrat envoyé');
  });

  it('renders preparation receipt without claiming a provider send or a signed contract', async () => {
    fixture.prepare.mockResolvedValue({ status: 'pending_approval', reused: false, contract_id: foreign, approval: {
      version: foreign, pdf_sha256: 'a'.repeat(64), pdf_url: 'https://example.invalid/preview',
      recipient_name: 'Partner A', recipient_email: 'a@example.invalid', sender_name: 'Fixture', sender_email: 'sender@example.invalid',
      company_name: 'Fictitious company', commission_first_payment: 7, commission_recurring: 2,
    } });
    await render(); await select(a); await act(async () => button().click());
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Contrat à approuver');
    expect(host.querySelector('[role="status"]')?.textContent).not.toMatch(/envoyé|signé/);
  });

  it.each(['dossier', 'account', 'logout', 'account-return'] as const)('ignores a late result after a %s change', async change => {
    const pending = deferred<PartnerContractResult>(); fixture.prepare.mockReturnValue(pending.promise);
    await render(); await select(a); await act(async () => button().click());
    if (change === 'dossier') await select(b);
    else { fixture.user = change === 'logout' ? null : { id: foreign }; await render(); }
    if (change === 'account-return') { fixture.user = { id: owner }; await render(); await select(a); }
    await act(async () => pending.resolve({ status: 'sent', reused: true, contract_id: foreign,
      docuseal_submission_id: 42, pdf_url: null, signing_url: null }));
    expect(host.querySelector('[role="status"]')).toBeNull();
    if (change === 'account' || change === 'logout') expect(host.textContent).not.toContain('Partner A');
    if (change === 'account-return') expect(button().disabled).toBe(false);
  });

  it('shows a preparation failure as an error without an approval or success receipt', async () => {
    fixture.prepare.mockRejectedValue(new Error('Aperçu indisponible'));
    await render(); await select(a); await act(async () => button().click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Aperçu indisponible');
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(button().disabled).toBe(false);
  });
});
