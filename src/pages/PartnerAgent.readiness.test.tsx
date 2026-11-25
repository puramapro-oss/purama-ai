import { act, useLayoutEffect, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerActive, PartnerCommission, PartnerConfig, PartnerProspect } from '@/lib/partner';
import { configFixture } from '../../tests/ui-state/fixtures';
import PartnerAgent from './PartnerAgent';
import PartnerAgentPartners from './PartnerAgentPartners';

const { auth, api, toast } = vi.hoisted(() => ({
  auth: { id: 'account-a' as string | null },
  api: { get: vi.fn(), update: vi.fn(), prospects: vi.fn(), partners: vi.fn(), stats: vi.fn(), commissions: vi.fn() },
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: auth.id ? { id: auth.id } : null }) }));
vi.mock('@/lib/partner', () => ({
  getPartnerConfig: api.get, updatePartnerConfig: api.update, listProspects: api.prospects,
  listActivePartners: api.partners, partnerStats: api.stats, listCommissions: api.commissions,
  formatEUR: (value: number) => `${value} €`,
  PIPELINE_COLUMNS: [{ id: 'identified', label: 'Identifiés', statuses: ['identified'] }],
  STATUS_META: { identified: { column: 'identified', emoji: '•' } },
  PARTNER_LEVELS: {
    starter: { label: 'Starter', emoji: '🌱' }, silver: { label: 'Argent', emoji: '🥈' },
    gold: { label: 'Or', emoji: '🥇' }, platinum: { label: 'Platine', emoji: '💎' },
    diamond: { label: 'Diamant', emoji: '🔷' }, titan: { label: 'Titan', emoji: '🚗' },
    eternal: { label: 'Éternel', emoji: '♾️' },
  },
}));
vi.mock('@/components/shared/TutorialOverlay', () => ({ TutorialOverlay: () => null }));
vi.mock('@/components/partner/PartnerAgentChat', () => ({ PartnerAgentChat: () => null }));
vi.mock('@/components/partner/PartnerAffiliationAdmissions', () => ({ PartnerAffiliationAdmissions: ({ ownerId }: { ownerId: string }) =>
  <section aria-label="Raccord affiliation">Dossiers du compte {ownerId}</section> }));
vi.mock('sonner', () => ({ toast }));
vi.mock('framer-motion', async () => {
  const React = await import('react');
  return { motion: { div: React.forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & {
    initial?: unknown; animate?: unknown; transition?: unknown;
  }>((props, ref) => {
    const attributes = { ...props }; delete attributes.initial; delete attributes.animate; delete attributes.transition;
    return React.createElement('div', { ...attributes, ref });
  }) } };
});

const A = 'account-a';
const B = 'account-b';
let root: Root;
let host: HTMLDivElement;
let layoutSnapshots: string[];
function Observation() {
  useLayoutEffect(() => { layoutSnapshots.push(host.textContent ?? ''); });
  return null;
}
function config(id: string, patch: Partial<PartnerConfig> = {}): PartnerConfig {
  return { ...configFixture('partner_agent_config', id, `Sender ${id}`), sender_email: `sender-${id}@example.invalid`, ...patch } as PartnerConfig;
}
function partner(id: string, patch: Partial<PartnerActive> = {}): PartnerActive {
  return { id: `partner-${id}`, user_id: id, prospect_id: `prospect-${id}`,
    partner_name: `PRIVATE-PARTNER-${id}`, partner_email: `${id}@example.invalid`,
    referral_code: `FIXTURE-${id}`, referral_link: `https://example.invalid/${id}`,
    total_clicks: 4, total_signups: 3, total_conversions: 2, total_revenue_generated: 100,
    total_commission_earned: 30, total_commission_paid: 0, level: 'starter', equity_granted: false,
    hereditary_commissions: false, tesla_reward: false, is_active: true,
    joined_at: '2026-11-24T12:00:00Z', last_activity_at: null, created_at: '2026-11-24T12:00:00Z', ...patch };
}
function commission(id: string): PartnerCommission {
  return { id: `commission-${id}`, user_id: id, partner_id: `partner-${id}`, type: 'first_payment',
    amount: 30, percentage: 30, source_payment_id: 'fixture-receipt', source_customer_email: `PRIVATE-CUSTOMER-${id}@example.invalid`,
    source_app: 'fixture', status: 'pending', paid_at: null, payment_method: null, created_at: '2026-11-24T12:00:00Z' };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function render(page: 'overview' | 'partners', id: string | null = auth.id) {
  auth.id = id;
  await act(async () => { root.render(<MemoryRouter>{page === 'overview' ? <PartnerAgent /> : <PartnerAgentPartners />}<Observation /></MemoryRouter>); });
}
function retry() { return [...host.querySelectorAll('button')].find(button => button.textContent === 'Réessayer le chargement')!; }
function toggle() { return host.querySelector<HTMLButtonElement>('button[role="switch"]')!; }
beforeEach(() => {
  vi.resetAllMocks(); auth.id = A; layoutSnapshots = [];
  api.get.mockImplementation(async (id: string) => config(id));
  api.update.mockImplementation(async (id: string, patch: Partial<PartnerConfig>) => config(id, patch));
  api.prospects.mockResolvedValue([] as PartnerProspect[]);
  api.partners.mockImplementation(async (id: string) => [partner(id)]);
  api.commissions.mockImplementation(async (id: string) => [commission(id)]);
  api.stats.mockResolvedValue({ prospectsTotal: 0, prospectsContacted: 0, prospectsInterested: 0,
    partnersActive: 1, emailsSent: 0, emailsReplied: 0, pendingCommissions: 30, totalRevenueGenerated: 100 });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected external request'); }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('partner overview readiness and recovery', () => {
  it.each(['get', 'prospects', 'partners', 'stats'] as const)('shows a persistent error after %s fails and recovers without activating', async source => {
    api[source].mockRejectedValueOnce(new Error('PRIVATE PROVIDER ERROR'));
    await render('overview');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Les chiffres ne sont pas disponibles');
    expect(host.textContent).not.toContain('PRIVATE PROVIDER ERROR');
    expect(host.querySelector('[aria-label="Chargement des partenariats"]')).toBeNull();
    await act(async () => { retry().click(); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain(`PRIVATE-PARTNER-${A}`);
    expect(api.update).not.toHaveBeenCalled();
  });

  it('does not submit two retry loads before the busy state renders', async () => {
    api.get.mockRejectedValueOnce(new Error('Unavailable'));
    await render('overview');
    const pending = deferred<PartnerConfig>(); api.get.mockReturnValueOnce(pending.promise);
    const button = retry();
    await act(async () => { button.click(); button.click(); });
    expect(api.get).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(config(A)));
    expect(host.textContent).toContain(`PRIVATE-PARTNER-${A}`);
  });

  it('rejects a wrong-owner configuration instead of displaying its data', async () => {
    api.get.mockResolvedValueOnce(config(B));
    await render('overview');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain(`PRIVATE-PARTNER-${A}`);
    expect(toggle()).toBeNull();
  });

  it('keeps activation as an authorization and describes the two media follow-ups accurately', async () => {
    await render('overview');
    expect(host.textContent).toContain('Médias et rédaction : au plus deux relances');
    expect(host.textContent).toContain('Cette autorisation ne confirme pas la connexion des services');
    expect(host.textContent).not.toContain('Recherche quotidienne');
    await act(async () => { toggle().click(); toggle().click(); });
    expect(api.update).toHaveBeenCalledExactlyOnceWith(A, { is_active: true });
    expect(toast.success).toHaveBeenCalledWith('Traitement des partenariats autorisé');
  });

  it('does not accept the old account toggle or release a new account toggle', async () => {
    const first = deferred<PartnerConfig>(); const second = deferred<PartnerConfig>();
    api.update.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await render('overview'); await act(async () => { toggle().click(); });
    await render('overview', B); await act(async () => { toggle().click(); });
    expect(toggle().disabled).toBe(true);
    await act(async () => first.resolve(config(A, { is_active: true })));
    expect(toggle().disabled).toBe(true);
    expect(toast.success).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain(`PRIVATE-PARTNER-${A}`);
    await act(async () => second.resolve(config(B, { is_active: true })));
    expect(toggle().disabled).toBe(false);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('rejects a wrong-account write receipt without changing activation', async () => {
    api.update.mockResolvedValueOnce(config(B, { is_active: true }));
    await render('overview'); await act(async () => { toggle().click(); });
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it('still allows pausing an active account whose sender identity is incomplete', async () => {
    api.get.mockResolvedValueOnce(config(A, { is_active: true, sender_name: null, sender_email: null }));
    await render('overview');
    expect(toggle().disabled).toBe(false);
    await act(async () => { toggle().click(); });
    expect(api.update).toHaveBeenCalledExactlyOnceWith(A, { is_active: false });
    expect(toast.success).toHaveBeenCalledWith('Agent en pause');
  });
});

describe('partner lists, histories and account boundaries', () => {
  it.each(['partners', 'commissions'] as const)('does not present a %s error as an empty list or zero money', async source => {
    api[source].mockRejectedValueOnce(new Error('PRIVATE PROVIDER ERROR'));
    await render('partners');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Aucun montant ne peut être confirmé');
    expect(host.textContent).not.toContain('Aucun partenaire référencé');
    expect(host.textContent).not.toContain('PRIVATE PROVIDER ERROR');
    expect(host.querySelector('[aria-label="Raccord affiliation"]')?.textContent).toContain(A);
    await act(async () => { retry().click(); });
    expect(host.textContent).toContain(`PRIVATE-PARTNER-${A}`);
    expect(host.textContent).toContain(`PRIVATE-CUSTOMER-${A}`);
  });

  it.each(['overview', 'partners'] as const)('hides prior-account data during the first %s layout before the successor loads', async page => {
    await render(page);
    expect(host.textContent).toContain(`PRIVATE-PARTNER-${A}`);
    const pending = deferred<PartnerActive[]>(); api.partners.mockReturnValueOnce(pending.promise);
    layoutSnapshots = [];
    await render(page, B);
    expect(layoutSnapshots.length).toBeGreaterThan(0);
    expect(layoutSnapshots.every(text => !text.includes(`PRIVATE-PARTNER-${A}`) && !text.includes(`PRIVATE-CUSTOMER-${A}`))).toBe(true);
    expect(host.textContent).not.toContain(`PRIVATE-PARTNER-${A}`);
    await act(async () => pending.resolve([partner(B)]));
    expect(host.textContent).toContain(`PRIVATE-PARTNER-${B}`);
  });

  it.each(['overview', 'partners'] as const)('ignores an old %s load after A to B to A', async page => {
    const obsolete = deferred<PartnerActive[]>(); api.partners.mockReturnValueOnce(obsolete.promise);
    await render(page); await render(page, B);
    api.partners.mockResolvedValueOnce([partner(A, { partner_name: 'CURRENT-A-SESSION' })]);
    await render(page, A);
    await act(async () => obsolete.resolve([partner(A, { partner_name: 'OBSOLETE-A-SESSION' })]));
    expect(host.textContent).toContain('CURRENT-A-SESSION');
    expect(host.textContent).not.toContain('OBSOLETE-A-SESSION');
  });

  it.each(['overview', 'partners'] as const)('ignores an obsolete %s failure after another account loads', async page => {
    const obsolete = deferred<PartnerActive[]>(); api.partners.mockReturnValueOnce(obsolete.promise);
    await render(page); await render(page, B);
    await act(async () => obsolete.reject(new Error('PRIVATE-A-ERROR')));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain(`PRIVATE-PARTNER-${B}`);
    expect(host.textContent).not.toContain('PRIVATE-A-ERROR');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each(['overview', 'partners'] as const)('clears %s on sign out without issuing another owner query', async page => {
    await render(page);
    const before = api.partners.mock.calls.length;
    await render(page, null);
    expect(host.textContent).toContain('Connectez-vous');
    expect(host.textContent).not.toContain('PRIVATE-');
    expect(api.partners).toHaveBeenCalledTimes(before);
  });

  it('rejects wrong-owner money and avoids showing an unverified empty balance', async () => {
    api.commissions.mockResolvedValueOnce([commission(B)]);
    await render('partners');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain(`PRIVATE-CUSTOMER-${B}`);
  });

  it('keeps the historic program and its original rewards on a linked legacy record', async () => {
    api.partners.mockResolvedValueOnce([partner(A, { outreach_profile: 'legacy', total_conversions: 500, level: 'diamond' })]);
    await render('partners');
    expect(host.textContent).toContain('Programme historique : avantages soumis aux conditions du contrat');
    expect(host.textContent).toContain('Tesla');
    expect(host.textContent).toContain('Diamant');
    expect(host.textContent).toContain('30 € gagné');
  });

  it.each(['media_affiliate', 'editorial', undefined] as const)('does not infer extra historic rewards for profile %s', async profile => {
    api.partners.mockResolvedValueOnce([partner(A, { outreach_profile: profile, total_conversions: 500, level: 'diamond' })]);
    await render('partners');
    expect(host.textContent).not.toContain('Tesla');
    expect(host.textContent).not.toContain('5% equity');
    expect(host.textContent).toContain('Les commissions et avantages applicables sont ceux de la convention');
    expect(host.textContent).toContain('30 € gagné');
  });

  it('distinguishes a stored inactive partner from an active one', async () => {
    api.partners.mockResolvedValueOnce([partner(A, { is_active: false })]);
    await render('partners');
    expect(host.textContent).toContain('Inactif');
    expect(host.textContent).not.toContain('Partenaires actifs');
  });
});
