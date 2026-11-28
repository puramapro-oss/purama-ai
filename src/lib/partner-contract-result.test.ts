import { describe, expect, it } from 'vitest';
import { contractFeedback, parsePartnerContractResult } from './partner-contract-result';

const pending = () => ({ status: 'pending_approval', contract_id: '00000000-0000-4000-8000-000000000001', reused: false,
  approval: { version: '00000000-0000-4000-8000-000000000002', pdf_sha256: 'a'.repeat(64),
    pdf_url: 'https://storage.example.invalid/exact.pdf', recipient_name: 'Camille', recipient_email: 'camille@example.invalid',
    sender_name: 'Émetteur', sender_email: 'sender@example.invalid', company_name: 'Fixture',
    commission_first_payment: 3, commission_recurring: 2 } });

describe('contract response boundary', () => {
  it('accepts the exact pending version and strips private server fields', () => {
    expect(parsePartnerContractResult({ ...pending(), claim_token: 'private-claim' })).toEqual(pending());
    expect(contractFeedback(parsePartnerContractResult(pending())).kind).toBe('info');
  });
  it.each([{}, { ok: true, pdf_url: 'https://storage.example.invalid/doc.pdf' }, { status: 'ready' },
    { status: ['sent'] }, { status: ['pending_approval'] }, [], null])(
    'rejects an old or non-discriminated response: %j', value => {
      expect(() => parsePartnerContractResult(value)).toThrow('Réponse du contrat invalide');
    });
  it.each([
    ['pdf_url', 'javascript:alert(1)'], ['pdf_url', 'http://example.invalid/doc.pdf'],
    ['pdf_url', 'https://secret@storage.example.invalid/doc.pdf'], ['version', 'old-version'],
    ['pdf_sha256', ''], ['recipient_email', ''], ['sender_name', ''],
    ['commission_first_payment', -1], ['commission_recurring', 101], ['commission_recurring', '2'],
  ])('blocks approval when %s is not an exact reviewable value', (key, value) => {
    const response = pending();
    expect(() => parsePartnerContractResult({ ...response, approval: { ...response.approval, [key]: value } }))
      .toThrow('Aperçu exact du contrat indisponible');
  });
  it.each([undefined, null, 0, -1, '42', 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'never reports sent without a valid provider submission identity: %j', submission => {
      expect(() => parsePartnerContractResult({ status: 'sent', contract_id: pending().contract_id,
        docuseal_submission_id: submission })).toThrow('Confirmation DocuSeal du contrat absente');
    });
  it('keeps provider acceptance distinct from signature and delivery', () => {
    const result = parsePartnerContractResult({ status: 'sent', contract_id: pending().contract_id,
      docuseal_submission_id: 42, signing_url: null, pdf_url: null, reused: true });
    expect(contractFeedback(result)).toEqual({ kind: 'success', title: 'Demande de signature déjà créée',
      description: 'DocuSeal a confirmé la création de la demande. La signature du partenaire reste à vérifier.' });
  });
  it.each(['unknown', 'in_progress', 'blocked', 'failed'])('never makes %s a send success', status => {
    expect(contractFeedback(parsePartnerContractResult({ status, reused: true })).kind).not.toBe('success');
  });
  it.each([
    ['media_contract_terms_incomplete', /Complétez les dix rubriques.*paramètres/],
    ['media_contract_terms_invalid', /10 et 2 000 caractères/],
    ['media_contract_offer_invalid', /qualification du prospect.*HTTPS/],
    ['media_contract_rate_mismatch', /30 %.*échéances admissibles/],
    ['media_contract_version_invalid', /version.*pas prise en charge/],
    ['media_contract_identity_invalid', /expéditeur.*entreprise.*partenaire/],
    ['editorial_contract_not_applicable', /rédactionnelle indépendante.*Aucun contrat d’affiliation/],
    ['contract_profile_invalid', /type de proposition.*qualification/],
    ['campaign_role_mismatch', /rôle du destinataire.*proposition éditoriale/],
    ['contact_qualification_required', /coordonnées.*qualifiées.*destinataire/],
    ['provider_opt_in_required', /autorisation.*retirée.*Aucune demande/],
  ])('explains the media or editorial refusal %s without reporting a send', (reason, explanation) => {
    const feedback = contractFeedback(parsePartnerContractResult({ status: 'blocked', reason, reused: false }));
    expect(feedback.kind).toBe('warning');
    expect(feedback.title).toBe('Contrat bloqué');
    expect(feedback.description).toMatch(explanation);
    expect(feedback.description).not.toContain(String(reason));
  });
  it('keeps an unknown blocked reason generic instead of displaying server details', () => {
    const feedback = contractFeedback(parsePartnerContractResult({ status: 'blocked', reason: 'private_provider_details', reused: false }));
    expect(feedback.kind).toBe('warning');
    expect(feedback.description).toContain('Vérifiez le dossier');
    expect(feedback.description).not.toContain('private_provider_details');
  });
});
