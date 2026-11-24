import { act, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerConfig } from '@/lib/partner';
import { configFixture } from '../../tests/ui-state/fixtures';
import PartnerAgentSettings from './PartnerAgentSettings';

const { auth, api, toast } = vi.hoisted(() => ({
  auth: { id: 'account-a' },
  api: { get: vi.fn(), update: vi.fn() },
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: auth.id } }) }));
vi.mock('@/lib/partner', () => ({
  getPartnerConfig: api.get, updatePartnerConfig: api.update, uploadSignature: vi.fn(),
  TONES: [{ value: 'professionnel_enthousiaste', label: 'Fictif' }], NICHES: [],
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('framer-motion', async () => {
  const React = await import('react');
  return { motion: { div: React.forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { initial?: unknown; animate?: unknown }>((props, ref) => {
    const attributes = { ...props }; delete attributes.initial; delete attributes.animate;
    return React.createElement('div', { ...attributes, ref });
  }) } };
});

let root: Root;
let host: HTMLDivElement;
function settings(id: string, patch: Partial<PartnerConfig> = {}): PartnerConfig {
  return { ...configFixture('partner_agent_config', id, `Sender ${id}`), outreach_timezone: 'UTC', ...patch } as PartnerConfig;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function render(id = auth.id) {
  auth.id = id;
  await act(async () => { root.render(<MemoryRouter><PartnerAgentSettings /></MemoryRouter>); });
}
function input(id: string) { return host.querySelector<HTMLInputElement>(`#${id}`)!; }
function clause(key: string) { return host.querySelector<HTMLTextAreaElement>(`#partner-media-${key}`)!; }
async function fill(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function save() {
  const button = [...host.querySelectorAll('button')].find(element => element.textContent?.trim() === 'Enregistrer')!;
  await act(async () => { button.click(); });
}

beforeEach(() => {
  vi.resetAllMocks(); auth.id = 'account-a';
  api.get.mockImplementation(async (id: string) => settings(id)); api.update.mockResolvedValue({});
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected external request'); }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('partner media settings', () => {
  it('defaults to explicit assistant identity and preserves historical commission values', async () => {
    api.get.mockResolvedValueOnce(settings('account-a', { commission_first_payment: 9, commission_recurring: 3 }));
    await render(); await save();
    expect(host.querySelector('#partner-outreach-identity')?.textContent).toContain('assistant IA');
    expect(host.textContent).toContain('30 %');
    expect(api.update).toHaveBeenCalledExactlyOnceWith('account-a', expect.objectContaining({
      outreach_identity_mode: 'assistant', commission_first_payment: 9, commission_recurring: 3,
      media_contract_terms: {},
    }));
  });

  it('requires approval when a human identity was loaded with an old disabled flag', async () => {
    api.get.mockResolvedValueOnce(settings('account-a', { outreach_identity_mode: 'human_reviewed', require_approval_outreach: false }));
    await render();
    expect(host.textContent).toContain('Chaque email doit être relu et validé');
    await save();
    expect(api.update.mock.calls[0][1]).toEqual(expect.objectContaining({
      outreach_identity_mode: 'human_reviewed', require_approval_outreach: true,
    }));
  });

  it('normalizes international targets and leaves empty targeting unrestricted', async () => {
    await render();
    await fill(input('partner-target-countries'), 'ch, US, ch,');
    await fill(input('partner-target-languages'), 'FR-ch, en, fr-CH,');
    await save();
    expect(api.update.mock.calls[0][1]).toEqual(expect.objectContaining({ target_countries: ['CH', 'US'], target_languages: ['fr-CH', 'en'] }));
    expect(input('partner-target-countries').value).toBe('CH, US');
    await fill(input('partner-target-countries'), ''); await fill(input('partner-target-languages'), '');
    await save();
    expect(api.update.mock.calls[1][1]).toEqual(expect.objectContaining({ target_countries: [], target_languages: [] }));
  });

  it.each([
    ['partner-target-countries', 'France, CH'],
    ['partner-target-languages', 'fr, not a language'],
    ['partner-target-countries', Array.from({ length: 21 }, (_, i) => `A${String.fromCharCode(65 + i)}`).join(',')],
  ])('rejects unusable targeting in %s before writing', async (id, value) => {
    await render(); await fill(input(id), value); await save();
    expect(api.update).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Ciblage invalide', expect.any(Object));
  });

  it('keeps an incomplete terms draft without supplying invented business clauses', async () => {
    await render(); await fill(clause('attribution'), 'À décider');
    await fill(clause('payment'), 'Conditions réellement convenues\nDeuxième paragraphe.'); await save();
    expect(api.update.mock.calls[0][1].media_contract_terms).toEqual({
      attribution: 'À décider', payment: 'Conditions réellement convenues\nDeuxième paragraphe.',
    });
    expect(host.querySelector('summary')?.textContent).toContain('1/10');
    expect(clause('duration_termination').value).toBe('');
  });

  it('rejects unsupported loaded terms rather than silently omitting them', async () => {
    api.get.mockResolvedValueOnce(settings('account-a', { media_contract_terms: { unknown_clause: 'A condition that must not disappear' } }));
    await render(); await save();
    expect(api.update).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Conditions médias invalides', expect.any(Object));
  });

  it('preserves target and clause edits made after the saved snapshot', async () => {
    const pending = deferred<unknown>(); api.update.mockReturnValueOnce(pending.promise);
    await render(); await fill(input('partner-target-countries'), 'ch');
    await fill(clause('costs'), 'Condition soumise au premier enregistrement.'); await save();
    await fill(input('partner-target-countries'), 'JP');
    await fill(clause('costs'), 'Nouvelle condition encore en cours de rédaction.');
    await act(async () => pending.resolve({}));
    expect(input('partner-target-countries').value).toBe('JP');
    expect(clause('costs').value).toBe('Nouvelle condition encore en cours de rédaction.');
    expect(api.update.mock.calls[0][1]).toEqual(expect.objectContaining({ target_countries: ['CH'],
      media_contract_terms: { costs: 'Condition soumise au premier enregistrement.' },
    }));
  });

  it('does not copy private terms from an old account when its save completes', async () => {
    const pending = deferred<unknown>(); api.update.mockReturnValueOnce(pending.promise);
    api.get.mockImplementation(async (id: string) => settings(id, { media_contract_terms: { costs: `Private conditions for ${id}` } }));
    await render(); await save(); await render('account-b');
    await act(async () => pending.resolve({}));
    expect(clause('costs').value).toBe('Private conditions for account-b');
    expect(toast.success).not.toHaveBeenCalled();
  });
});
