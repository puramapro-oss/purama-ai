import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsultationPanel } from './ConsultationPanel';
import { ConsultationClientError, type ConsultationOperation } from '@/lib/consultation-client';
import { catalogFixture, deferred, operationFixture, OPERATION, OWNER, OTHER_OWNER } from '@/test/consultation-fixtures';

const { api, secondApi, factory } = vi.hoisted(() => ({
  api: { catalog: vi.fn(), consult: vi.fn(), status: vi.fn(), cancel: vi.fn() },
  secondApi: { catalog: vi.fn(), consult: vi.fn(), status: vi.fn(), cancel: vi.fn() },
  factory: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: vi.fn() } } }));
vi.mock('@/lib/consultation-client', async original => ({
  ...await original<typeof import('@/lib/consultation-client')>(), createConsultationClient: factory,
}));

let root: Root;
let host: HTMLDivElement;
const pendingKey = (owner = OWNER) => `purama.consultation.pending.${owner}`;
async function render(owner = OWNER, token = 'first-token') {
  await act(async () => { root.render(<ConsultationPanel userId={owner} accessToken={token} />); });
}
function button(label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.trim() === label);
  if (!found) throw new Error(`Bouton absent : ${label}`);
  return found;
}
async function click(label: string) { await act(async () => { button(label).click(); }); }
function field(label: string) {
  const found = host.querySelector<HTMLTextAreaElement | HTMLSelectElement>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`Champ absent : ${label}`);
  return found;
}
async function fill(label: string, value: string) {
  const element = field(label);
  await act(async () => {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
async function review(model: string) {
  const label = [...host.querySelectorAll<HTMLLabelElement>('label')].find(element => element.textContent?.startsWith(model));
  const checkbox = label?.querySelector<HTMLInputElement>('input');
  if (!checkbox) throw new Error(`Avis absent : ${model}`);
  await act(async () => { checkbox.click(); });
}
beforeEach(() => {
  vi.resetAllMocks(); sessionStorage.clear();
  factory.mockImplementation(token => token === 'second-token' ? secondApi : api);
  for (const client of [api, secondApi]) {
    client.catalog.mockResolvedValue(catalogFixture());
    client.consult.mockImplementation(async request => operationFixture(request.operationId));
    client.status.mockImplementation(async id => operationFixture(id));
    client.cancel.mockImplementation(async id => operationFixture(id, 'cancelled'));
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); host.remove(); sessionStorage.clear();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('ConsultationPanel — actual controls and lifecycle', () => {
  it('sends the chosen model, reflection, speed and opt-in public research exactly once', async () => {
    const pending = deferred<ConsultationOperation>(); api.consult.mockReturnValueOnce(pending.promise);
    await render();
    await fill('Question de consultation', 'Ma question confidentielle.');
    await fill('Réflexion de la consultation', 'maximum');
    await fill('Vitesse de la consultation', 'ultra_fast');
    await review('reviewer-model');
    await fill('Requêtes publiques', 'Une question publique');
    await fill('Pages HTTPS', 'https://example.com/public');
    await act(async () => { const send = button('Lancer la consultation'); send.click(); send.click(); });
    expect(api.consult).toHaveBeenCalledTimes(1);
    const [request, signal] = api.consult.mock.calls[0];
    expect(request).toEqual({ operationId: expect.any(String), question: 'Ma question confidentielle.',
      preferences: { model: 'primary-model', reflection: 'maximum', speed: 'ultra_fast' },
      reviewerModels: ['reviewer-model'], research: { queries: ['Une question publique'], urls: ['https://example.com/public'] },
    });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(request)).not.toContain('userId');
    expect(sessionStorage.getItem(pendingKey())).toBe(request.operationId);
    expect(Object.values(sessionStorage).join('')).not.toMatch(/confidentielle|token|publique/);
    await act(async () => { pending.resolve(operationFixture(request.operationId)); });
    expect(host.textContent).toContain('Une réponse utile.');
  });

  it('keeps over-limit selections and public inputs visible after changing profile, blocking submission until adjusted', async () => {
    await render(); await fill('Question de consultation', 'Question');
    await review('reviewer-model'); await review('third-model');
    await fill('Requêtes publiques', 'première\ndeuxième'); await fill('Pages HTTPS', 'https://example.com/1\nhttps://example.com/2');
    await fill('Vitesse de la consultation', 'ultra_fast');
    expect(host.querySelectorAll('input:checked')).toHaveLength(2);
    expect(field('Requêtes publiques').value).toBe('première\ndeuxième');
    expect(field('Pages HTTPS').value).toBe('https://example.com/1\nhttps://example.com/2');
    expect(host.textContent).toContain('Retirez les avis en trop');
    expect(host.textContent).toContain('Retirez les requêtes en trop');
    expect(host.textContent).toContain('Retirez les adresses en trop');
    expect(button('Lancer la consultation').disabled).toBe(true);
    await click('Lancer la consultation'); expect(api.consult).not.toHaveBeenCalled();
    await review('third-model'); await fill('Requêtes publiques', 'première'); await fill('Pages HTTPS', 'https://example.com/1');
    expect(button('Lancer la consultation').disabled).toBe(false);
    await fill('Modèle principal', 'reviewer-model');
    expect(host.querySelectorAll('input:checked')).toHaveLength(1);
    expect(host.textContent).toContain('déjà principal, retirer cet avis');
    expect(button('Lancer la consultation').disabled).toBe(true);
  });

  it.each([
    ['simulation_enabled', 'mode simulation'], ['budget_unavailable', 'capacité financée'], ['account_unavailable', 'compte fournisseur'],
    ['model_unavailable', 'Aucun modèle compatible'], ['not_configured', 'pas encore configurée'],
    ['paused', 'suspendue par l’exploitation'], ['service_unavailable', 'temporairement indisponible'],
  ] as const)('shows %s without an enabled consultation control', async (reason, label) => {
    api.catalog.mockResolvedValueOnce({ ...catalogFixture(), available: false, reason, models: [] });
    await render(); expect(host.textContent).toContain(label);
    expect(field('Modèle principal').matches(':disabled')).toBe(true);
    expect(field('Réflexion de la consultation').matches(':disabled')).toBe(true);
    expect(button('Lancer la consultation').disabled).toBe(true);
    expect(api.consult).not.toHaveBeenCalled();
  });

  it('does not launch research implicitly and blocks explicit inputs when the provider is unavailable', async () => {
    api.catalog.mockResolvedValueOnce({ ...catalogFixture(), research: { search: false, scrape: false } });
    await render(); await fill('Question de consultation', 'Question');
    await fill('Requêtes publiques', 'Une requête');
    expect(button('Lancer la consultation').disabled).toBe(true);
    expect(host.textContent).toContain('Retirez les requêtes pour continuer');
    await fill('Requêtes publiques', ''); await click('Lancer la consultation');
    expect(api.consult.mock.calls[0][0]).toMatchObject({ reviewerModels: [], research: { queries: [], urls: [] } });
  });

  it('blocks requests that fit individual character limits but exceed the combined UTF-8 payload limit', async () => {
    await render(); await fill('Question de consultation', '界'.repeat(8000));
    await fill('Requêtes publiques', Array.from({ length: 3 }, () => '界'.repeat(2000)).join('\n'));
    await fill('Pages HTTPS', Array.from({ length: 6 }, (_, index) => `https://example.com/${index}/${'a'.repeat(8100)}`).join('\n'));
    expect(host.textContent).toContain('L’ensemble de la question et des recherches est trop volumineux');
    expect(button('Lancer la consultation').disabled).toBe(true);
    expect(api.consult).not.toHaveBeenCalled(); expect(sessionStorage.getItem(pendingKey())).toBeNull();
  });

  it('aborts the local request and sends durable cancellation for the same operation, ignoring a late answer', async () => {
    const pending = deferred<ConsultationOperation>(); api.consult.mockReturnValueOnce(pending.promise);
    await render(); await fill('Question de consultation', 'Question'); await click('Lancer la consultation');
    const [request, signal] = api.consult.mock.calls[0];
    await click('Arrêter la consultation');
    expect(signal.aborted).toBe(true);
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith(request.operationId, expect.any(AbortSignal));
    expect(host.textContent).toContain('Consultation annulée.');
    await act(async () => { pending.resolve(operationFixture(request.operationId)); });
    expect(host.textContent).not.toContain('Une réponse utile.');
    expect(host.textContent).toContain('Consultation annulée.');
    expect(api.consult).toHaveBeenCalledTimes(1);
  });

  it('retains only the operation UUID on network loss and resumes with status after remount', async () => {
    api.consult.mockRejectedValueOnce(new ConsultationClientError('unavailable'));
    await render(); await fill('Question de consultation', 'Question privée'); await click('Lancer la consultation');
    const operationId = api.consult.mock.calls[0][0].operationId;
    expect(sessionStorage.getItem(pendingKey())).toBe(operationId);
    expect(host.textContent).not.toContain('Nouvelle consultation');
    await act(async () => { root.render(null); }); await render();
    expect(field('Question de consultation').value).toBe('');
    expect(host.textContent).toContain('Cette demande reste à vérifier.');
    await click('Vérifier le résultat');
    expect(api.status).toHaveBeenCalledExactlyOnceWith(operationId, expect.any(AbortSignal));
    expect(api.consult).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Une réponse utile.');
  });

  it('does not claim that an absent or failed cancellation is complete', async () => {
    sessionStorage.setItem(pendingKey(), OPERATION); api.cancel.mockResolvedValueOnce(null);
    await render(); await click('Arrêter la consultation');
    expect(host.textContent).toContain('Aucun résultat confirmé');
    expect(host.textContent).not.toContain('Consultation annulée.');
    expect(host.textContent).not.toContain('Nouvelle consultation');
    api.cancel.mockRejectedValueOnce(new Error('secret provider message'));
    await click('Arrêter la consultation');
    expect(host.textContent).toContain('L’annulation n’a pas été confirmée');
    expect(host.textContent).not.toContain('secret');
    expect(api.consult).not.toHaveBeenCalled();
  });

  it('clears the old account before paint, aborts its work and does not surface its late result', async () => {
    const pending = deferred<ConsultationOperation>(); api.consult.mockReturnValueOnce(pending.promise);
    await render(); await fill('Question de consultation', 'Secret du premier compte'); await click('Lancer la consultation');
    const [request, signal] = api.consult.mock.calls[0];
    await render(OTHER_OWNER, 'second-token');
    expect(signal.aborted).toBe(true);
    expect(field('Question de consultation').value).toBe('');
    expect(host.textContent).not.toContain('Vérifier le résultat');
    expect(sessionStorage.getItem(pendingKey(OTHER_OWNER))).toBeNull();
    await act(async () => { pending.resolve(operationFixture(request.operationId)); });
    expect(host.textContent).not.toContain('Une réponse utile.');
    expect(secondApi.status).not.toHaveBeenCalled(); expect(secondApi.cancel).not.toHaveBeenCalled();
    await fill('Question de consultation', 'Question du second compte'); await click('Lancer la consultation');
    expect(secondApi.consult).toHaveBeenCalledTimes(1);
    expect(secondApi.consult.mock.calls[0][0].question).toBe('Question du second compte');
    expect(secondApi.consult.mock.calls[0][0].operationId).not.toBe(request.operationId);
  });

  it('renders sources and model text as text, includes uncertainty, and distinguishes usage reconciliation', async () => {
    sessionStorage.setItem(pendingKey(), OPERATION);
    const response = operationFixture(OPERATION, 'reconciliation_required');
    response.result!.answer = '<img src=x onerror=alert(1)> réponse';
    response.result!.sources[0].title = '<script>source</script>';
    api.status.mockResolvedValueOnce(response);
    await render(); await click('Vérifier le résultat');
    expect(host.textContent).toContain('<img src=x onerror=alert(1)> réponse');
    expect(host.querySelector('script, img')).toBeNull();
    const link = host.querySelector('a');
    expect(link?.href).toBe('https://example.com/source'); expect(link?.rel).toBe('noopener noreferrer');
    expect(host.textContent).toContain('Sources non vérifiées');
    expect(host.textContent).toContain('Les estimations diffèrent'); expect(host.textContent).toContain('La date reste incertaine');
    expect(host.textContent).toContain('Le suivi des usages doit être rapproché');
    expect(api.consult).not.toHaveBeenCalled();
  });
});
