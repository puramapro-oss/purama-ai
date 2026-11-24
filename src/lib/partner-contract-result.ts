export type PartnerContractStatus = 'pending_approval' | 'in_progress' | 'sent' | 'unknown' | 'blocked' | 'failed';

export interface PartnerContractApproval {
  version: string;
  pdf_sha256: string;
  pdf_url: string;
  recipient_name: string;
  recipient_email: string;
  sender_name: string;
  sender_email: string;
  company_name: string;
  commission_first_payment: number;
  commission_recurring: number;
}

type ContractBase = { contract_id?: string; reason?: string; reused: boolean };
export type PartnerContractResult = ContractBase & (
  | { status: 'pending_approval'; contract_id: string; approval: PartnerContractApproval }
  | { status: 'sent'; contract_id: string; docuseal_submission_id: number; pdf_url: string | null; signing_url: string | null }
  | { status: 'in_progress' | 'unknown' | 'blocked' | 'failed' }
);

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = /^[0-9a-f]{64}$/;
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function httpsUrl(value: unknown): value is string {
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

/** A provider status or an old {ok:true,pdf_url} response cannot stand in for a receipt. */
export function parsePartnerContractResult(value: unknown): PartnerContractResult {
  if (!record(value) || typeof value.status !== 'string'
    || !['pending_approval', 'in_progress', 'sent', 'unknown', 'blocked', 'failed'].includes(value.status)) {
    throw new Error('Réponse du contrat invalide');
  }
  if (value.contract_id != null && (!text(value.contract_id) || !uuid.test(value.contract_id))) {
    throw new Error('Identifiant du contrat invalide');
  }
  const base: ContractBase = {
    reused: value.reused === true,
    ...(text(value.contract_id) ? { contract_id: value.contract_id } : {}),
    ...(text(value.reason) ? { reason: value.reason } : {}),
  };
  if (value.status === 'pending_approval') {
    const approval = value.approval;
    if (!base.contract_id || !record(approval)
      || !text(approval.version) || !uuid.test(approval.version)
      || !text(approval.pdf_sha256) || !sha256.test(approval.pdf_sha256)
      || !httpsUrl(approval.pdf_url)
      || !['recipient_name', 'recipient_email', 'sender_name', 'sender_email', 'company_name'].every(key => text(approval[key]))
      || !email.test(String(approval.recipient_email)) || !email.test(String(approval.sender_email))
      || !['commission_first_payment', 'commission_recurring'].every(key => typeof approval[key] === 'number'
        && Number.isFinite(approval[key]) && Number(approval[key]) >= 0 && Number(approval[key]) <= 100)) {
      throw new Error('Aperçu exact du contrat indisponible');
    }
    return { ...base, status: 'pending_approval', contract_id: base.contract_id, approval: {
      version: approval.version, pdf_sha256: approval.pdf_sha256, pdf_url: approval.pdf_url,
      recipient_name: String(approval.recipient_name), recipient_email: String(approval.recipient_email),
      sender_name: String(approval.sender_name), sender_email: String(approval.sender_email), company_name: String(approval.company_name),
      commission_first_payment: Number(approval.commission_first_payment), commission_recurring: Number(approval.commission_recurring),
    } };
  }
  if (value.status === 'sent') {
    if (!base.contract_id || typeof value.docuseal_submission_id !== 'number'
      || !Number.isSafeInteger(value.docuseal_submission_id) || value.docuseal_submission_id <= 0) {
      throw new Error('Confirmation DocuSeal du contrat absente');
    }
    if ((value.pdf_url != null && !httpsUrl(value.pdf_url)) || (value.signing_url != null && !httpsUrl(value.signing_url))) {
      throw new Error('Lien du contrat invalide');
    }
    return { ...base, status: 'sent', contract_id: base.contract_id, docuseal_submission_id: value.docuseal_submission_id,
      pdf_url: typeof value.pdf_url === 'string' ? value.pdf_url : null,
      signing_url: typeof value.signing_url === 'string' ? value.signing_url : null };
  }
  return { ...base, status: value.status as 'in_progress' | 'unknown' | 'blocked' | 'failed' };
}

export function contractFeedback(result: PartnerContractResult): {
  kind: 'success' | 'info' | 'warning' | 'error'; title: string; description: string;
} {
  switch (result.status) {
    case 'pending_approval': return { kind: 'info', title: 'Contrat à approuver',
      description: 'Le PDF est préparé. Vérifiez son contenu et le destinataire avant de l’approuver.' };
    case 'sent': return { kind: 'success', title: result.reused ? 'Demande de signature déjà créée' : 'Demande de signature créée',
      description: 'DocuSeal a confirmé la création de la demande. La signature du partenaire reste à vérifier.' };
    case 'in_progress': return { kind: 'info', title: 'Contrat en cours de traitement',
      description: 'Cette action est déjà prise en charge. Vous pouvez vérifier son état sans relancer l’envoi.' };
    case 'unknown': return { kind: 'warning', title: 'Envoi du contrat à vérifier',
      description: 'Le résultat doit être rapproché de DocuSeal. Aucun renvoi automatique ne sera effectué.' };
    case 'failed': return { kind: 'error', title: 'Préparation du contrat interrompue',
      description: 'Vérifiez les informations du dossier et l’historique avant de reprendre la préparation.' };
    case 'blocked': {
      const reasons: Record<string, string> = {
        stale_approval: 'La version du contrat ne correspond plus à l’aperçu. Rechargez le document avant toute validation.',
        context_changed: 'Les parties ou les conditions ont changé depuis la préparation. Une nouvelle revue est nécessaire.',
        recipient_changed: 'Le destinataire a changé depuis la préparation. Vérifiez le dossier.',
        sender_changed: 'L’identité de l’expéditeur a changé depuis la préparation. Vérifiez le dossier.',
        contact_suppressed: 'Ce contact a refusé la prospection.',
        contact_qualification_required: 'Les coordonnées doivent être qualifiées pour ce destinataire avant de préparer une demande de signature.',
        provider_opt_in_required: 'L’autorisation d’envoi est absente ou a été retirée. Aucune demande de signature ne sera envoyée.',
        agent_inactive: 'L’agent partenariat est désactivé.',
        prospect_not_interested: 'Le dossier doit être qualifié comme intéressé avant de préparer un contrat.',
        already_sent: 'Une demande de signature existe déjà pour ce dossier.',
        historical_contract: 'Un contrat antérieur est enregistré. Vérifiez-le avant toute nouvelle demande.',
        preview_unavailable: 'Le PDF exact n’est pas accessible. L’approbation reste désactivée.',
        approval_required: 'Relisez le PDF exact pour autoriser cette demande de signature.',
        previous_attempt_requires_review: 'Une tentative antérieure doit être vérifiée avant tout nouvel envoi.',
        media_contract_terms_incomplete: 'Complétez les dix rubriques « Conditions des contrats médias » dans les paramètres du partenariat avant de préparer le contrat.',
        media_contract_terms_invalid: 'Vérifiez les dix rubriques « Conditions des contrats médias » dans les paramètres : chaque rubrique doit contenir entre 10 et 2 000 caractères de texte valide.',
        media_contract_offer_invalid: 'Dans la qualification du prospect, renseignez le nom de l’offre et une page de présentation HTTPS valide.',
        media_contract_rate_mismatch: 'Le projet média doit appliquer 30 % au premier paiement et aux échéances admissibles. Faites vérifier le projet avant de reprendre sa préparation.',
        media_contract_version_invalid: 'La version des conditions du contrat média n’est pas prise en charge. Faites vérifier le projet avant de reprendre sa préparation.',
        media_contract_identity_invalid: 'Vérifiez le nom et l’email de l’expéditeur, le nom de l’entreprise et les coordonnées du partenaire avant de préparer le contrat.',
        editorial_contract_not_applicable: 'Ce dossier concerne une proposition rédactionnelle indépendante. Aucun contrat d’affiliation ne sera préparé pour ce profil.',
        contract_profile_invalid: 'Vérifiez le type de proposition dans la qualification du prospect avant de préparer un contrat.',
        campaign_role_mismatch: 'La proposition de contrat doit correspondre au rôle du destinataire. Vérifiez la qualification ; une rédaction indépendante reçoit une proposition éditoriale.',
      };
      return { kind: 'warning', title: 'Contrat bloqué',
        description: reasons[result.reason ?? ''] ?? 'Les conditions de préparation ou d’envoi ne sont pas réunies. Vérifiez le dossier.' };
    }
  }
}
