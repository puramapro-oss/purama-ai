import { supabase } from '@/integrations/supabase/client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,512}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
type ReadResult = { data: unknown; error: unknown };
const completionClient = supabase as unknown as {
  rpc(name: 'partner_affiliation_admission_prepare', args: { p_prospect_id: string }): Promise<ReadResult>;
  rpc(name: 'partner_affiliation_candidates', args: { p_page: number }): Promise<ReadResult>;
};

export type PartnerReplyIntent = 'request_details' | 'share_offer';
export type PartnerReplyPreparation =
  | { status: 'prepared' | 'existing'; log_id: string; user_id: string; prospect_id: string; gmail_message_id: string }
  | { status: 'blocked' | 'unknown'; reason?: string };

export async function preparePartnerReply(
  ownerId: string, prospectId: string, gmailMessageId: string, intent: PartnerReplyIntent, signal?: AbortSignal,
): Promise<PartnerReplyPreparation> {
  if (!UUID.test(ownerId) || !UUID.test(prospectId) || !MESSAGE_ID.test(gmailMessageId)
    || !['request_details', 'share_offer'].includes(intent)) throw new Error('Réponse partenaire invalide.');
  const { data, error } = await supabase.functions.invoke('partner-prepare-reply', {
    body: { prospect_id: prospectId, gmail_message_id: gmailMessageId, intent }, signal,
  });
  // A transport error does not establish whether a local draft was persisted.
  if (error) throw new Error('La préparation n’a pas pu être confirmée. Réessayez pour retrouver le même brouillon.');
  if (!record(data)) throw new Error('Le résultat de la préparation n’est pas vérifiable.');
  if (data.status === 'blocked' || data.status === 'unknown') {
    return { status: data.status, ...(typeof data.reason === 'string' ? { reason: data.reason } : {}) };
  }
  if ((data.status !== 'prepared' && data.status !== 'existing') || typeof data.log_id !== 'string'
    || !UUID.test(data.log_id) || data.user_id !== ownerId || data.prospect_id !== prospectId
    || data.gmail_message_id !== gmailMessageId) throw new Error('Le brouillon ne correspond pas à cette réponse.');
  return { status: data.status, log_id: data.log_id, user_id: ownerId, prospect_id: prospectId, gmail_message_id: gmailMessageId };
}

export function partnerReplyPreparationMessage(result: PartnerReplyPreparation): string {
  if (result.status === 'prepared') return 'Le brouillon est prêt à être relu. Ouvrez-le pour vérifier le texte et approuver son envoi.';
  if (result.status === 'existing') return 'Un élément existe déjà pour cette réponse. Son contenu a été conservé ; ouvrez-le pour vérifier son état.';
  if (result.status === 'unknown') return 'La création du brouillon doit être vérifiée. Aucun e-mail n’a été envoyé par cette préparation.';
  const reasons: Record<string, string> = {
    agent_inactive: 'Activez le traitement des partenariats dans les paramètres pour préparer une réponse.',
    connection_unavailable: 'Connectez la boîte Gmail utilisée pour ce partenariat.',
    connection_changed: 'La connexion de messagerie a changé. Vérifiez-la avant de préparer la réponse.',
    contact_suppressed: 'Ce destinataire a fait opposition. Aucune réponse commerciale ne sera préparée.',
    provider_opt_in_required: 'L’autorisation de contact est absente ou retirée. Vérifiez le dossier.',
    contact_qualification_required: 'Les coordonnées de ce destinataire doivent être qualifiées.',
    stale_reply: 'Une réponse plus récente existe. Actualisez le dossier avant de continuer.',
    reply_not_human: 'Ce reçu ne permet pas de préparer une réponse : refus ou message automatique.',
    reply_not_found: 'Cette réponse vérifiée n’est plus accessible. Actualisez le dossier.',
    reply_proof_mismatch: 'Le message reçu ne correspond plus à la preuve conservée. Vérifiez le fil dans votre messagerie.',
    unsupported_language: 'La langue de ce contact n’est pas encore disponible pour cette préparation.',
    context_changed: 'Le destinataire, l’offre ou les autorisations ont changé. Actualisez le dossier.',
    draft_rejected: 'Le brouillon précédent a été rejeté. Consultez son état avant toute nouvelle préparation.',
    reply_draft_rejected: 'Le brouillon précédent a été rejeté. Consultez son état dans la messagerie avant de poursuivre.',
    reply_mailbox_required: 'Connectez la boîte Gmail déclarée pour ce partenariat.',
    latest_human_reply_required: 'Actualisez le dossier : seule la dernière réponse humaine vérifiée peut être traitée.',
    reply_receipt_changed: 'La preuve de réception a changé. Actualisez le dossier et vérifiez le fil.',
    reply_proof_changed: 'Le fil de réponse ne correspond plus aux preuves d’envoi. Vérifiez la messagerie.',
    recipient_blocked: 'Ce destinataire est bloqué dans les réglages de la messagerie.',
    media_profile_required: 'Cette préparation est disponible pour les contacts médias et les propositions rédactionnelles qualifiés.',
    reply_context_changed: 'Les informations du partenariat ont changé. Actualisez le dossier avant de reprendre.',
    reply_context_unavailable: 'Le dossier ne peut pas être chargé. Réessayez lorsque la connexion est rétablie.',
    reply_context_unverified: 'Les informations du partenariat doivent être vérifiées avant de préparer une réponse.',
    mailbox_identity_unverified: 'L’identité de la boîte connectée doit être vérifiée.',
    reply_content_unverified: 'Le contenu intégral du message n’a pas pu être vérifié. Consultez le fil dans votre messagerie.',
    partner_reply_draft_changed: 'Le brouillon ou les conditions ont changé depuis la préparation. Vérifiez son état dans la messagerie.',
    existing_reply_requires_review: 'Un élément existe déjà pour ce message. Consultez son état dans la messagerie avant de poursuivre.',
    previous_reply_requires_review: 'Une réponse précédente doit être vérifiée dans la messagerie avant toute nouvelle préparation.',
    outreach_language_unsupported: 'La langue de ce contact n’est pas encore disponible pour cette préparation.',
    human_review_required: 'L’identité choisie nécessite une relecture humaine. Vérifiez les paramètres et la signature du message.',
    invalid_sender: 'Complétez l’identité de l’expéditeur dans les paramètres du partenariat.',
    offer_required: 'Complétez l’offre dans la qualification du contact.',
  };
  return reasons[('reason' in result ? result.reason : undefined) ?? ''] ?? 'Les conditions de préparation ne sont pas réunies. Vérifiez la réponse et la qualification du contact.';
}

export interface MediaAffiliationCandidate {
  id: string; user_id: string; name: string; contract_signed_at: string | null;
}

export async function listMediaAffiliationCandidates(ownerId: string, page = 0): Promise<{
  candidates: MediaAffiliationCandidate[]; hasMore: boolean;
}> {
  if (!UUID.test(ownerId) || !Number.isSafeInteger(page) || page < 0 || page > 100_000) throw new Error('Page de dossiers invalide.');
  // The signed contract is authoritative even after the prospect is reclassified
  // or refuses further contact. A list read grants no contact or payment rights.
  const { data, error } = await completionClient.rpc('partner_affiliation_candidates', { p_page: page });
  if (error) throw new Error('Les accords médias ne sont pas disponibles. Réessayez le chargement.');
  if (!record(data) || data.status !== 'ready' || data.user_id !== ownerId
    || typeof data.has_more !== 'boolean' || !Array.isArray(data.candidates) || data.candidates.length > 25
    || data.candidates.some(row => !record(row) || row.user_id !== ownerId
      || typeof row.id !== 'string' || !UUID.test(row.id) || typeof row.name !== 'string'
      || typeof row.contract_signed_at !== 'string' || !Number.isFinite(Date.parse(row.contract_signed_at)))
    || new Set(data.candidates.map(row => row.id)).size !== data.candidates.length) {
    throw new Error('La liste des accords médias ne peut pas être vérifiée.');
  }
  return { candidates: (data.candidates as Array<Record<string, unknown>>).map(row => ({ id: String(row.id), user_id: ownerId, name: String(row.name),
    contract_signed_at: String(row.contract_signed_at) })), hasMore: data.has_more };
}

export interface PartnerAffiliationAdmission {
  id: string; version: 1; user_id: string; prospect_id: string; contract_id: string;
  created_at: string; snapshot: Record<string, unknown>;
}
export type PartnerAffiliationPreparation =
  | { status: 'prepared'; reused: boolean; admission: PartnerAffiliationAdmission; integration: {
    status: 'requirements_missing'; missing: string[]; activation_allowed: false; payment_allowed: false; one_revision: string;
  } }
  | { status: 'blocked'; reason?: string };

export async function preparePartnerAffiliationAdmission(ownerId: string, prospectId: string): Promise<PartnerAffiliationPreparation> {
  if (!UUID.test(ownerId) || !UUID.test(prospectId)) throw new Error('Accord média invalide.');
  const { data, error } = await completionClient.rpc('partner_affiliation_admission_prepare', { p_prospect_id: prospectId });
  if (error) throw new Error('La préparation du dossier n’a pas pu être confirmée. Réessayez pour retrouver sa version enregistrée.');
  if (!record(data)) throw new Error('Dossier d’affiliation non vérifiable.');
  if (data.status === 'blocked') return { status: 'blocked', ...(typeof data.reason === 'string' ? { reason: data.reason } : {}) };
  const admission = data.admission;
  const integration = data.integration;
  if (data.status !== 'prepared' || !record(admission) || admission.version !== 1
    || admission.user_id !== ownerId || admission.prospect_id !== prospectId || !record(admission.snapshot)
    || !['id', 'contract_id'].every(key => typeof admission[key] === 'string' && UUID.test(admission[key] as string))
    || typeof admission.created_at !== 'string' || !Number.isFinite(Date.parse(admission.created_at))
    || !record(integration) || integration.status !== 'requirements_missing' || integration.activation_allowed !== false
    || integration.payment_allowed !== false || !Array.isArray(integration.missing)
    || integration.missing.length === 0 || !integration.missing.every(code => typeof code === 'string' && /^[a-z_]{1,80}$/.test(code))
    || typeof integration.one_revision !== 'string' || !/^[0-9a-f]{40}$/.test(integration.one_revision)) {
    throw new Error('Dossier d’affiliation non vérifiable.');
  }
  const document = admission.snapshot.document;
  if (!record(document) || typeof document.approved_pdf_sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(document.approved_pdf_sha256)) throw new Error('L’empreinte du contrat approuvé est absente.');
  const snapshot = admission.snapshot;
  const inner = snapshot.integration;
  const contract = snapshot.contract_snapshot;
  if (snapshot.schema_version !== 1 || snapshot.source !== 'purama_ai_signed_media_contract'
    || snapshot.owner_id !== ownerId || snapshot.prospect_id !== prospectId || snapshot.contract_id !== admission.contract_id
    || snapshot.beneficiary_id !== null || snapshot.financial_authority !== 'none'
    || document.approved_by !== ownerId || typeof document.approval_version !== 'string' || !UUID.test(document.approval_version)
    || !record(contract) || contract.outreach_profile !== 'media_affiliate' || contract.media_terms_version !== '20261124'
    || contract.commission_first_payment !== 30 || contract.commission_recurring !== 30
    || !record(inner) || inner.status !== integration.status || inner.activation_allowed !== false || inner.payment_allowed !== false
    || inner.one_revision !== integration.one_revision || !Array.isArray(inner.missing)
    || inner.missing.length !== integration.missing.length || inner.missing.some((value, index) => value !== integration.missing[index])) {
    throw new Error('Les preuves du dossier d’affiliation ne correspondent pas à cet accord.');
  }
  return { status: 'prepared', reused: data.reused === true, admission: {
    id: String(admission.id), version: 1, user_id: ownerId, prospect_id: prospectId,
    contract_id: String(admission.contract_id), created_at: admission.created_at, snapshot: admission.snapshot,
  }, integration: { status: 'requirements_missing', missing: integration.missing as string[],
    activation_allowed: false, payment_allowed: false, one_revision: integration.one_revision } };
}

export const AFFILIATION_REQUIREMENTS: Record<string, string> = {
  beneficiary_identity: 'Identité du bénéficiaire vérifiée dans ONE',
  tenant_mapping: 'Rattachement de l’entité commerciale et du compte partenaire',
  catalog_binding: 'Produits et prix reliés au catalogue',
  executable_policy: 'Conditions d’attribution et de commission structurées',
  verified_attribution: 'Attribution de la vente prouvée selon l’accord',
  provider_settlement: 'Encaissement, devise et remboursements rapprochés',
  one_runtime: 'Service d’affiliation ONE et persistance qualifiés',
  payout_runtime: 'Service de règlement du bénéficiaire qualifié',
};

export function partnerAffiliationBlockedMessage(reason?: string): string {
  const messages: Record<string, string> = {
    prospect_not_found: 'Cet accord n’est pas accessible sur ce compte.',
    contract_not_signed: 'La signature du contrat doit être confirmée dans le hub de contrats.',
    signature_not_verified: 'La preuve de signature ne correspond pas au contrat approuvé.',
    contract_not_found: 'Aucun contrat média traçable n’est disponible pour cet accord.',
    contract_profile_invalid: 'Le dossier d’affiliation médias concerne uniquement les accords médias à 30 %.',
    admission_conflict: 'Une différence a été détectée avec le dossier enregistré. Vérifiez le contrat et son historique.',
    contract_not_prepared: 'Aucun contrat traçable n’a été préparé dans ce dossier.',
    media_contract_required: 'Seuls les contrats médias à 30 % utilisent ce dossier d’affiliation.',
    media_contract_snapshot_invalid: 'Les conditions figées du contrat média doivent être vérifiées.',
    contract_source_mismatch: 'La version approuvée, le PDF et la demande de signature ne concordent pas.',
    signed_contract_required: 'Le hub de contrats doit confirmer la signature complète de cet accord.',
    signature_evidence_required: 'Les signatures et leur événement de confirmation doivent être rapprochés.',
    approval_evidence_required: 'La preuve d’approbation du PDF exact doit être retrouvée.',
    dispatch_evidence_required: 'La preuve d’envoi de cette version du contrat doit être retrouvée.',
    admission_source_changed: 'Les preuves diffèrent de celles du dossier conservé. Vérifiez l’historique du contrat.',
  };
  return messages[reason ?? ''] ?? 'Le contrat, son approbation et sa signature doivent être rapprochés avant de préparer le dossier.';
}
