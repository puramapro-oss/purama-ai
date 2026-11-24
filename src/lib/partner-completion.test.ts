import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listMediaAffiliationCandidates, preparePartnerAffiliationAdmission, preparePartnerReply,
  partnerReplyPreparationMessage } from './partner-completion';
import { listActivePartners, partnerStats } from './partner';

const api = vi.hoisted(() => ({ invoke: vi.fn(), rpc: vi.fn(), from: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: api.invoke }, rpc: api.rpc, from: api.from } }));
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const prospect = '33333333-3333-4333-8333-333333333333';
const log = '44444444-4444-4444-8444-444444444444';
const contract = '55555555-5555-4555-8555-555555555555';
const message = 'gmail_001';
const prepared = () => ({ status: 'prepared', log_id: log, user_id: owner, prospect_id: prospect, gmail_message_id: message });
const integration = () => ({ status: 'requirements_missing', missing: ['beneficiary_identity', 'one_runtime'],
  activation_allowed: false, payment_allowed: false, one_revision: 'a5fed2edaaa2332c0e9aba3321d9ee32cf89a17e' });
const admission = () => ({ status: 'prepared', reused: false, admission: { id: log, version: 1, user_id: owner,
  prospect_id: prospect, contract_id: contract, created_at: '2026-11-24T12:00:00Z',
  snapshot: { schema_version: 1, source: 'purama_ai_signed_media_contract', owner_id: owner, prospect_id: prospect,
    contract_id: contract, beneficiary_id: null, financial_authority: 'none', integration: integration(),
    document: { approved_pdf_sha256: 'a'.repeat(64), approval_version: log, approved_by: owner },
    contract_snapshot: { outreach_profile: 'media_affiliate', media_terms_version: '20261124', commission_first_payment: 30, commission_recurring: 30 } } },
  integration: integration() });
function query(data: unknown, error: unknown = null) {
  const result = Promise.resolve({ data, error });
  const chain = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), order: vi.fn(), range: vi.fn(), not: vi.fn(),
    then: result.then.bind(result) };
  for (const key of ['select', 'eq', 'in', 'order', 'range', 'not'] as const) chain[key].mockReturnValue(chain);
  return chain;
}
beforeEach(() => { vi.resetAllMocks(); });

describe('partner completion transport boundaries', () => {
  it('returns only a matching local reply log and never claims a send', async () => {
    api.invoke.mockResolvedValue({ data: { ...prepared(), provider_token: 'private' }, error: null });
    const controller = new AbortController();
    const value = await preparePartnerReply(owner, prospect, message, 'share_offer', controller.signal);
    expect(value).toEqual(prepared());
    expect(api.invoke).toHaveBeenCalledExactlyOnceWith('partner-prepare-reply', {
      body: { prospect_id: prospect, gmail_message_id: message, intent: 'share_offer' }, signal: controller.signal,
    });
    expect(partnerReplyPreparationMessage(value)).toContain('approuver son envoi');
  });
  it.each(['user_id', 'prospect_id', 'gmail_message_id', 'log_id'])('rejects wrong reply identity %s', async field => {
    api.invoke.mockResolvedValue({ data: { ...prepared(), [field]: 'different' }, error: null });
    await expect(preparePartnerReply(owner, prospect, message, 'request_details')).rejects.toThrow('ne correspond pas');
  });
  it.each(['blocked', 'unknown'])('never exposes a usable log for %s', async status => {
    api.invoke.mockResolvedValue({ data: { ...prepared(), status, reason: 'contact_suppressed' }, error: null });
    const value = await preparePartnerReply(owner, prospect, message, 'request_details');
    expect(value).toEqual({ status, reason: 'contact_suppressed' });
    expect(value).not.toHaveProperty('log_id');
  });
  it('treats ambiguous preparation as unconfirmed, without claiming rollback', async () => {
    api.invoke.mockResolvedValue({ data: prepared(), error: new Error('provider private detail') });
    await expect(preparePartnerReply(owner, prospect, message, 'request_details')).rejects.toThrow('retrouver le même brouillon');
  });
  it('rejects invalid input before a call', async () => {
    await expect(preparePartnerReply(owner, prospect, '<injected>', 'request_details')).rejects.toThrow('invalide');
    expect(api.invoke).not.toHaveBeenCalled();
  });
  it('retains the original verified admission and explicit inactive state', async () => {
    api.rpc.mockResolvedValue({ data: admission(), error: null });
    expect(await preparePartnerAffiliationAdmission(owner, prospect)).toEqual(admission());
    expect(api.rpc).toHaveBeenCalledExactlyOnceWith('partner_affiliation_admission_prepare', { p_prospect_id: prospect });
  });
  it.each(['activation_allowed', 'payment_allowed'])('rejects an unqualified %s assertion', async key => {
    const value = admission();
    api.rpc.mockResolvedValue({ data: { ...value, integration: { ...value.integration, [key]: true } }, error: null });
    await expect(preparePartnerAffiliationAdmission(owner, prospect)).rejects.toThrow('non vérifiable');
  });
  it.each(['user_id', 'prospect_id', 'contract_id', 'id'])('rejects a mismatched admission %s', async key => {
    const value = admission();
    api.rpc.mockResolvedValue({ data: { ...value, admission: { ...value.admission, [key]: 'wrong' } }, error: null });
    await expect(preparePartnerAffiliationAdmission(owner, prospect)).rejects.toThrow('non vérifiable');
  });
  it('requires the exact PDF digest before enabling export', async () => {
    const value = admission(); value.admission.snapshot.document.approved_pdf_sha256 = '';
    api.rpc.mockResolvedValue({ data: value, error: null });
    await expect(preparePartnerAffiliationAdmission(owner, prospect)).rejects.toThrow('empreinte');
  });
  it.each([
    ['owner_id', other], ['prospect_id', other], ['contract_id', log], ['schema_version', 2],
    ['source', 'unverified'], ['beneficiary_id', owner], ['financial_authority', 'payment'],
  ])('rejects contradictory embedded %s in an otherwise matching export', async (key, value) => {
    const result = admission();
    api.rpc.mockResolvedValue({ data: { ...result, admission: { ...result.admission,
      snapshot: { ...result.admission.snapshot, [key]: value } } }, error: null });
    await expect(preparePartnerAffiliationAdmission(owner, prospect)).rejects.toThrow('preuves du dossier');
  });
  it.each([
    ['payment_allowed', true], ['activation_allowed', true], ['one_revision', 'b'.repeat(40)],
    ['missing', []], ['status', 'active'],
  ])('rejects contradictory embedded integration %s', async (key, value) => {
    const result = admission();
    api.rpc.mockResolvedValue({ data: { ...result, admission: { ...result.admission, snapshot: { ...result.admission.snapshot,
      integration: { ...result.integration, [key]: value } } } }, error: null });
    await expect(preparePartnerAffiliationAdmission(owner, prospect)).rejects.toThrow('preuves du dossier');
  });
  it.each([
    ['commission_first_payment', 50], ['commission_recurring', 10], ['outreach_profile', 'legacy'], ['media_terms_version', 'unknown'],
  ])('rejects another commercial policy in embedded %s', async (key, value) => {
    const result = admission();
    api.rpc.mockResolvedValue({ data: { ...result, admission: { ...result.admission, snapshot: { ...result.admission.snapshot,
      contract_snapshot: { ...result.admission.snapshot.contract_snapshot, [key]: value } } } }, error: null });
    await expect(preparePartnerAffiliationAdmission(owner, prospect)).rejects.toThrow('preuves du dossier');
  });
  it('keeps a refused admission separate from a prepared dossier', async () => {
    api.rpc.mockResolvedValue({ data: { status: 'blocked', reason: 'contract_not_signed', admission: admission().admission }, error: null });
    expect(await preparePartnerAffiliationAdmission(owner, prospect)).toEqual({ status: 'blocked', reason: 'contract_not_signed' });
  });
  it('reads signed media snapshots without relying on mutable prospect qualification', async () => {
    const row = { id: prospect, user_id: owner, name: 'Média test', contract_signed_at: '2026-11-24T12:00:00Z' };
    api.rpc.mockResolvedValue({ data: { status: 'ready', user_id: owner, candidates: [row], has_more: true }, error: null });
    const value = await listMediaAffiliationCandidates(owner, 1);
    expect(value.candidates).toEqual([row]); expect(value.hasMore).toBe(true);
    expect(api.rpc).toHaveBeenCalledExactlyOnceWith('partner_affiliation_candidates', { p_page: 1 });
    expect(api.from).not.toHaveBeenCalled();
  });
  it('rejects a foreign candidate and a failed read', async () => {
    api.rpc.mockResolvedValue({ data: { status: 'ready', user_id: owner, has_more: false,
      candidates: [{ id: prospect, user_id: other, name: 'Private', contract_signed_at: '2026-11-24T12:00:00Z' }] }, error: null });
    await expect(listMediaAffiliationCandidates(owner)).rejects.toThrow('ne peut pas être vérifiée');
    api.rpc.mockResolvedValue({ data: null, error: { message: 'unavailable' } });
    await expect(listMediaAffiliationCandidates(owner)).rejects.toThrow('ne sont pas disponibles');
  });
  it.each([{ status: 'blocked', reason: 'authentication_required' },
    { status: 'ready', user_id: other, candidates: [], has_more: false },
    { status: 'ready', user_id: owner, candidates: [], has_more: 'false' }])('rejects an unverified candidate envelope %j', async data => {
    api.rpc.mockResolvedValue({ data, error: null });
    await expect(listMediaAffiliationCandidates(owner)).rejects.toThrow('ne peut pas être vérifiée');
  });
  it('rejects invalid pagination before the request', async () => {
    await expect(listMediaAffiliationCandidates(owner, -1)).rejects.toThrow('Page de dossiers invalide');
    expect(api.rpc).not.toHaveBeenCalled();
  });
});

describe('partner account projection and statistics', () => {
  it('derives a profile only from the same owner and removes joined data', async () => {
    api.from.mockReturnValue(query([
      { id: log, user_id: owner, prospect: { user_id: owner, outreach_profile: 'media_affiliate' }, equity_granted: true },
      { id: contract, user_id: owner, outreach_profile: 'legacy', prospect: { user_id: other, outreach_profile: 'legacy' } },
      { id: prospect, user_id: other, prospect: { user_id: other, outreach_profile: 'legacy' } },
    ]));
    const rows = await listActivePartners(owner);
    expect(rows).toHaveLength(2); expect(rows[0].outreach_profile).toBe('media_affiliate');
    expect(rows[0].equity_granted).toBe(true); expect(rows[0]).not.toHaveProperty('prospect');
    expect(rows[1].outreach_profile).toBeUndefined();
  });
  it.each(['partner_prospects', 'partner_emails', 'partner_active', 'partner_commissions'])(
    'does not turn an error from %s into zero statistics', async failed => {
      api.from.mockImplementation((table: string) => query([], table === failed ? { message: 'denied' } : null));
      await expect(partnerStats(owner)).rejects.toThrow('statistiques partenaires ne sont pas disponibles');
    });
  it('still returns true zero activity for successful empty datasets', async () => {
    api.from.mockReturnValue(query([]));
    const stats = await partnerStats(owner);
    expect(Object.values(stats)).toEqual(Array(8).fill(0));
  });
});
