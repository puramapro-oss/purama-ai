import { act, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PartnerAgentProspects from './PartnerAgentProspects';

const { auth, api, toast } = vi.hoisted(() => ({
  auth: { user: null as { id: string } | null }, api: { list: vi.fn(), invoke: vi.fn() },
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: api.invoke } } }));
vi.mock('@/lib/partner', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/partner')>(), listProspects: api.list }));
vi.mock('sonner', () => ({ toast }));
vi.mock('framer-motion', async () => {
  const React = await import('react');
  return { motion: { div: React.forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { initial?: unknown; animate?: unknown }>((props, ref) => {
    const attributes = { ...props }; delete attributes.initial; delete attributes.animate;
    return React.createElement('div', { ...attributes, ref });
  }) } };
});

const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const prospectId = '00000000-0000-4000-8000-000000000011';
const contractId = '00000000-0000-4000-8000-000000000031';
const version = '00000000-0000-4000-8000-000000000041';
const digest = 'a'.repeat(64);
const pending = { status: 'pending_approval', contract_id: contractId, reused: false,
  approval: { version, pdf_sha256: digest, pdf_url: 'https://storage.example.invalid/exact.pdf',
    recipient_name: 'Camille Fixture', recipient_email: 'camille@example.invalid', sender_name: 'Émetteur',
    sender_email: 'sender@example.invalid', company_name: 'Fixture', commission_first_payment: 3, commission_recurring: 2 } };
const prospect = { id: prospectId, user_id: owner, name: 'Camille Fixture', email: 'camille@example.invalid',
  status: 'interested', type: 'influencer', ai_score: null, tags: [], social_links: {} };
const response = (data: unknown) => ({ data, error: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let root: Root;
let host: HTMLDivElement;
async function render(path = '/dashboard/partner-agent/prospects') {
  await act(async () => { root.render(<MemoryRouter initialEntries={[path]}><PartnerAgentProspects /></MemoryRouter>); });
}
function button(name: string): HTMLButtonElement {
  const item = [...document.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === name || value.title === name);
  if (!item) throw new Error(`Missing button: ${name}`);
  return item;
}
async function click(name: string) { await act(async () => button(name).click()); }
async function readPdf() {
  const checkbox = document.querySelector<HTMLButtonElement>('#contract-read');
  if (!checkbox) throw new Error('Missing review checkbox');
  await act(async () => checkbox.click());
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.user = { id: owner };
  api.list.mockImplementation(async id => id === owner ? [prospect] : []);
  api.invoke.mockReset().mockResolvedValue(response(pending));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network access'); }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('real partner contract review with the real client response parser', () => {
  it('prepares without sending, shows exact parties/PDF, and requires an explicit review', async () => {
    await render(); await click('Préparer le contrat');
    expect(api.invoke).toHaveBeenCalledExactlyOnceWith('partner-contract-action', { body: { action: 'prepare', prospect_id: prospectId } });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Camille Fixture · camille@example.invalid');
    const link = [...document.querySelectorAll<HTMLAnchorElement>('a')].find(value => value.textContent?.includes('Ouvrir le PDF à approuver'))!;
    expect(link.href).toBe(pending.approval.pdf_url);
    expect(link.rel).toBe('noopener noreferrer');
    expect(button('Approuver ce PDF et envoyer').disabled).toBe(true);
    expect(toast.success).not.toHaveBeenCalled();
    await readPdf(); expect(button('Approuver ce PDF et envoyer').disabled).toBe(false);
  });
  it('submits the exact reviewed version/hash only once on a double click and waits for the receipt', async () => {
    const accepted = deferred<ReturnType<typeof response>>();
    api.invoke.mockResolvedValueOnce(response(pending)).mockImplementationOnce(() => accepted.promise);
    await render(); await click('Préparer le contrat'); await readPdf();
    const approve = button('Approuver ce PDF et envoyer');
    await act(async () => { approve.click(); approve.click(); });
    expect(api.invoke).toHaveBeenCalledTimes(2);
    expect(api.invoke).toHaveBeenLastCalledWith('partner-contract-action', { body: {
      action: 'approve', prospect_id: prospectId, approval_version: version, pdf_sha256: digest } });
    expect(approve.disabled).toBe(true); expect(toast.success).not.toHaveBeenCalled();
    await act(async () => accepted.resolve(response({ status: 'sent', contract_id: contractId, docuseal_submission_id: 42, reused: false })));
    expect(toast.success).toHaveBeenCalledWith('Demande de signature créée', expect.any(Object));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Référence DocuSeal : 42');
    expect(document.querySelector('#contract-read')).toBeNull();
  });
  it.each(['unknown', 'missing_receipt', 'network_failure'])('offers only status verification when approval outcome is %s', async outcome => {
    api.invoke.mockResolvedValueOnce(response(pending));
    if (outcome === 'network_failure') api.invoke.mockRejectedValueOnce(new Error('Network lost'));
    else api.invoke.mockResolvedValueOnce(response(outcome === 'unknown' ? { status: 'unknown', contract_id: contractId, reused: false }
      : { status: 'sent', contract_id: contractId, reused: false }));
    api.invoke.mockResolvedValueOnce(response({ status: 'unknown', contract_id: contractId, reused: true }));
    await render(); await click('Préparer le contrat'); await readPdf(); await click('Approuver ce PDF et envoyer');
    expect(document.querySelector('#contract-read')).toBeNull(); expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalled();
    await click('Vérifier l’état et l’aperçu');
    expect(api.invoke).toHaveBeenLastCalledWith('partner-contract-action', { body: { action: 'preview', prospect_id: prospectId } });
    expect(api.invoke.mock.calls.filter(([, options]) => options.body.action === 'approve')).toHaveLength(1);
  });
  it('does not reuse a refused approval version', async () => {
    api.invoke.mockResolvedValueOnce(response(pending)).mockResolvedValueOnce(response({ status: 'blocked', reason: 'stale_approval', reused: true }));
    await render(); await click('Préparer le contrat'); await readPdf(); await click('Approuver ce PDF et envoyer');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Rechargez le document');
    expect(document.querySelector('#contract-read')).toBeNull(); expect(toast.success).not.toHaveBeenCalled();
  });
  it('opens a chat deep link as a read of the existing PDF without generation or send', async () => {
    await render(`/dashboard/partner-agent/prospects?contractProspect=${prospectId}`);
    expect(api.invoke).toHaveBeenCalledExactlyOnceWith('partner-contract-action', { body: { action: 'preview', prospect_id: prospectId } });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
  it('discards a late PDF response across logout and login to the same account', async () => {
    const prepared = deferred<ReturnType<typeof response>>();
    api.invoke.mockImplementationOnce(() => prepared.promise);
    await render(); await click('Préparer le contrat');
    auth.user = null; await render(); auth.user = { id: owner }; await render();
    await act(async () => prepared.resolve(response(pending)));
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(toast.info).not.toHaveBeenCalled();
  });
  it('closes the approval on account change and never approves the previous account document', async () => {
    await render(); await click('Préparer le contrat'); await readPdf();
    auth.user = { id: other }; await render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(api.invoke).toHaveBeenCalledTimes(1);
  });
  it('serializes preparation across prospects and binds the read confirmation to one document', async () => {
    const secondId = '00000000-0000-4000-8000-000000000012';
    api.list.mockResolvedValue([prospect, { ...prospect, id: secondId, name: 'Second dossier' }]);
    const prepared = deferred<ReturnType<typeof response>>();
    api.invoke.mockImplementationOnce(() => prepared.promise);
    await render();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('button[title="Préparer le contrat"]')];
    await act(async () => { buttons[0].click(); buttons[1].click(); });
    expect(api.invoke).toHaveBeenCalledTimes(1);
    expect(buttons.every(value => value.disabled)).toBe(true);
    await act(async () => prepared.resolve(response(pending)));
    await readPdf(); await click('Fermer');
    api.invoke.mockResolvedValueOnce(response({ ...pending, approval: { ...pending.approval,
      version: '00000000-0000-4000-8000-000000000042', pdf_sha256: 'b'.repeat(64) } }));
    await act(async () => buttons[1].click());
    expect(button('Approuver ce PDF et envoyer').disabled).toBe(true);
    expect(document.querySelector('#contract-read')?.getAttribute('aria-checked')).toBe('false');
    expect(api.invoke.mock.calls.filter(([, options]) => options.body.action === 'approve')).toHaveLength(0);
  });
  it('discards a late outreach approval when its account is no longer active', async () => {
    const sent = deferred<ReturnType<typeof response>>();
    api.list.mockImplementation(async id => id === owner ? [{ ...prospect, status: 'ready_to_contact' }] : []);
    api.invoke.mockImplementationOnce(() => sent.promise);
    vi.stubGlobal('confirm', vi.fn(() => true));
    await render(); await click('Premier email de partenariat');
    auth.user = { id: other }; await render();
    await act(async () => sent.resolve(response({ status: 'pending_approval', email_id: contractId, reused: false,
      approval: { version, from: 'Sender', to: prospect.email, subject: 'PRIVATE', body_html: '<p>PRIVATE DRAFT</p>' } })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).not.toContain('PRIVATE DRAFT');
    expect(toast.info).not.toHaveBeenCalled();
  });
  it('fails closed during partial deployment without calling the legacy endpoint that sends immediately', async () => {
    api.invoke.mockResolvedValueOnce({ data: null, error: new Error('Function not deployed (404)') });
    await render(); await click('Préparer le contrat');
    expect(api.invoke).toHaveBeenCalledExactlyOnceWith('partner-contract-action', { body: { action: 'prepare', prospect_id: prospectId } });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Aperçu du contrat indisponible', expect.any(Object));
  });
});
