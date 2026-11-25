import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PartnerAffiliationAdmissions } from './PartnerAffiliationAdmissions';
import type { PartnerAffiliationPreparation, MediaAffiliationCandidate } from '@/lib/partner-completion';

const api = vi.hoisted(() => ({ list: vi.fn(), prepare: vi.fn() }));
vi.mock('@/lib/partner-completion', async original => ({ ...await original<typeof import('@/lib/partner-completion')>(),
  listMediaAffiliationCandidates: api.list, preparePartnerAffiliationAdmission: api.prepare }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const admissionId = '44444444-4444-4444-8444-444444444444';
const row: MediaAffiliationCandidate = { id, user_id: owner, name: 'Accord privé A', contract_signed_at: '2026-11-24T12:00:00Z' };
const prepared: PartnerAffiliationPreparation = { status: 'prepared', reused: false,
  admission: { id: admissionId, version: 1, user_id: owner, prospect_id: id, contract_id: other,
    created_at: '2026-11-24T12:00:00Z', snapshot: { document: { approved_pdf_sha256: 'a'.repeat(64) } } },
  integration: { status: 'requirements_missing', missing: ['beneficiary_identity', 'one_runtime'], activation_allowed: false,
    payment_allowed: false, one_revision: 'a5fed2edaaa2332c0e9aba3321d9ee32cf89a17e' } };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
let root: Root; let host: HTMLDivElement;
const render = (user = owner) => act(async () => root.render(<MemoryRouter><PartnerAffiliationAdmissions ownerId={user} /></MemoryRouter>));
function button(label: string) { return [...host.querySelectorAll('button')].find(item => item.textContent === label)!; }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); api.list.mockReset(); api.prepare.mockReset();
  api.list.mockResolvedValue({ candidates: [row], hasMore: false }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('signed media admission view', () => {
  it('only reads on mount and distinguishes preparation from financial activation', async () => {
    api.prepare.mockResolvedValue(prepared); await render(); expect(api.prepare).not.toHaveBeenCalled();
    await act(async () => button('Préparer le dossier d’affiliation').click());
    expect(host.textContent).toContain('L’affiliation et les versements restent à raccorder');
    expect(host.textContent).toContain('Identité du bénéficiaire vérifiée dans ONE');
    expect(button('Exporter le dossier vérifié')).toBeDefined();
  });
  it('deduplicates a repeated click on the same agreement', async () => {
    const wait = deferred<PartnerAffiliationPreparation>(); api.prepare.mockReturnValue(wait.promise); await render();
    await act(async () => { button('Préparer le dossier d’affiliation').click(); button('Préparer le dossier d’affiliation').click(); });
    expect(api.prepare).toHaveBeenCalledExactlyOnceWith(owner, id);
    await act(async () => wait.resolve(prepared));
  });
  it('does not expose an export after a blocked signature', async () => {
    api.prepare.mockResolvedValue({ status: 'blocked', reason: 'signed_contract_required' }); await render();
    await act(async () => button('Préparer le dossier d’affiliation').click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('signature complète');
    expect(host.textContent).not.toContain('Exporter le dossier');
  });
  it('offers a real retry instead of presenting an error as an empty list', async () => {
    api.list.mockRejectedValueOnce(new Error('Indisponible')); await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Indisponible');
    expect(host.textContent).not.toContain('Aucun accord');
    await act(async () => button('Réessayer les accords').click()); expect(host.textContent).toContain('Accord privé A');
  });
  it('uses the next bounded page without carrying the prior rows while loading', async () => {
    api.list.mockResolvedValueOnce({ candidates: [row], hasMore: true }); await render();
    const wait = deferred<{ candidates: MediaAffiliationCandidate[]; hasMore: boolean }>(); api.list.mockReturnValueOnce(wait.promise);
    await act(async () => button('Page suivante').click());
    expect(api.list).toHaveBeenLastCalledWith(owner, 1); expect(host.textContent).not.toContain('Accord privé A');
    await act(async () => wait.resolve({ candidates: [], hasMore: false })); expect(host.textContent).toContain('Page 2');
  });
  it('hides the previous owner before the next account read completes', async () => {
    await render(); api.list.mockReturnValueOnce(new Promise(() => {})); await render(other);
    expect(host.textContent).not.toContain('Accord privé A');
  });
  it('ignores late admission results across owner A → B → A', async () => {
    const wait = deferred<PartnerAffiliationPreparation>(); api.prepare.mockReturnValue(wait.promise); await render();
    await act(async () => button('Préparer le dossier d’affiliation').click());
    api.list.mockResolvedValueOnce({ candidates: [], hasMore: false }); await render(other); await render(owner);
    await act(async () => wait.resolve(prepared)); expect(host.textContent).not.toContain('Exporter le dossier');
  });
  it('exports exactly the verified dossier only on explicit action', async () => {
    const create = vi.fn((_blob: Blob) => 'blob:admission'); const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    api.prepare.mockResolvedValue(prepared); await render();
    await act(async () => button('Préparer le dossier d’affiliation').click()); expect(create).not.toHaveBeenCalled();
    await act(async () => button('Exporter le dossier vérifié').click());
    expect(create).toHaveBeenCalledTimes(1); expect(click).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);
  });
});
