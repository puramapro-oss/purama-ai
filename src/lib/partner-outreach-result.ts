export type OutreachStatus = 'sent' | 'pending_approval' | 'in_progress' | 'unknown' | 'blocked' | 'failed';
export type OutreachStep = 'outreach' | 'relance_1' | 'relance_2' | 'relance_3';

export function outreachStepForStatus(status: string): OutreachStep | null {
  switch (status) {
    case 'identified': case 'ready_to_contact': return 'outreach';
    case 'contacted': return 'relance_1';
    case 'relance_1': return 'relance_2';
    case 'relance_2': return 'relance_3';
    default: return null;
  }
}
export interface OutreachApproval {
  version: string;
  from: string;
  to: string;
  subject: string;
  body_html: string;
}
export interface OutreachResult {
  status: OutreachStatus;
  email_id?: string;
  message_id?: string;
  reason?: string;
  reused: boolean;
  approval?: OutreachApproval;
}

/** The UI only claims a send when the server returns a provider message ID. */
export function parseOutreachResult(value: unknown): OutreachResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Réponse d’envoi invalide');
  const row = value as Record<string, unknown>;
  if (!['sent', 'pending_approval', 'in_progress', 'unknown', 'blocked', 'failed'].includes(String(row.status))) {
    throw new Error('Statut d’envoi inconnu');
  }
  if (row.status === 'sent' && (typeof row.message_id !== 'string' || !row.message_id.trim())) {
    throw new Error('Confirmation du service d’envoi absente');
  }
  let approval: OutreachApproval | undefined;
  if (row.status === 'pending_approval') {
    const preview = row.approval as Record<string, unknown> | null;
    if (typeof row.email_id !== 'string' || !row.email_id || !preview || typeof preview !== 'object'
      || !['version', 'from', 'to', 'subject', 'body_html'].every(key => typeof preview[key] === 'string' && String(preview[key]).trim())) {
      throw new Error('Aperçu de validation indisponible');
    }
    approval = { version: String(preview.version), from: String(preview.from), to: String(preview.to),
      subject: String(preview.subject), body_html: String(preview.body_html) };
  }
  return {
    status: row.status as OutreachStatus, reused: row.reused === true,
    ...(typeof row.email_id === 'string' ? { email_id: row.email_id } : {}),
    ...(typeof row.message_id === 'string' ? { message_id: row.message_id } : {}),
    ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
    ...(approval ? { approval } : {}),
  };
}

export function outreachFeedback(result: OutreachResult): {
  kind: 'success' | 'info' | 'warning' | 'error'; title: string; description: string;
} {
  switch (result.status) {
    case 'sent': return { kind: 'success', title: result.reused ? 'Email déjà transmis' : 'Email transmis',
      description: 'Le service d’envoi a confirmé la prise en charge du message.' };
    case 'pending_approval': return { kind: 'info', title: 'En attente de validation',
      description: 'Le brouillon est enregistré. Aucun email n’a été envoyé.' };
    case 'in_progress': return { kind: 'info', title: 'Traitement en cours',
      description: 'Cette action est déjà prise en charge. Aucun nouvel envoi n’a été lancé.' };
    case 'unknown': return { kind: 'warning', title: 'Envoi à vérifier',
      description: 'Le résultat doit être vérifié auprès du service d’envoi. Aucun renvoi automatique ne sera effectué.' };
    case 'failed': return { kind: 'error', title: 'Envoi non confirmé',
      description: 'L’action a échoué. Vérifiez son historique avant de préparer une nouvelle action.' };
    case 'blocked': {
      const reasons: Record<string, string> = {
        contact_suppressed: 'Ce contact a refusé la prospection.',
        contact_has_replied: 'Ce contact a déjà répondu. Traitez sa réponse avant toute nouvelle sollicitation.',
        agent_inactive: 'L’agent partenariat est désactivé.',
        daily_limit: 'La limite quotidienne d’envoi est atteinte.',
        already_contacted: 'Le premier contact a déjà été effectué.',
        followup_not_due: 'Cette relance n’est pas prévue ou n’est pas encore due.',
        prospect_approval_required: 'Ce prospect doit être validé avant la préparation de l’email.',
        recipient_changed: 'Le destinataire a changé depuis la préparation.',
        sender_changed: 'L’identité de l’expéditeur a changé depuis la préparation.',
        previous_attempt_requires_review: 'Une tentative antérieure existe. Son résultat doit être vérifié avant tout nouvel envoi.',
        stale_approval: 'Ce brouillon a changé. Rechargez son aperçu avant de le valider.',
      };
      return { kind: 'warning', title: 'Envoi bloqué',
        description: reasons[result.reason ?? ''] ?? 'Les conditions d’envoi ne sont pas réunies. Aucun nouvel email n’a été envoyé.' };
    }
  }
}
