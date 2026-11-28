import { FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';
import { readBoundedBytes } from '../../supabase/functions/_shared/request-body';
import { cancelResponseQuietly } from './request-deadline';
import type { PartnerProspect } from './partner';

type FailureStatus = 'failed' | 'partial' | 'unknown';
const DISCOVERY_BATCH_LIMIT = 25;
const messages = {
  unauthorized: 'Reconnectez-vous avant de lancer une recherche de prospects.',
  invalid_request: 'Vérifiez le texte et les critères de la recherche.',
  invalid_request_body: 'La requête de recherche est incomplète. Vérifiez les critères saisis.',
  service_not_configured: 'La recherche de prospects doit être configurée avant son utilisation.',
  configuration_unavailable: 'Les réglages de recherche sont temporairement indisponibles.',
  provider_unavailable: 'Le service de recherche est temporairement indisponible.',
  invalid_search_response: 'La réponse du service de recherche n’a pas pu être validée.',
  invalid_provider_response: 'La réponse du service de recherche n’a pas pu être validée.',
  invalid_extraction: 'Les propositions de recherche n’ont pas pu être validées.',
  incomplete_extraction: 'Les propositions de recherche sont incomplètes.',
  prospect_lookup_unavailable: 'La vérification des doublons est temporairement indisponible.',
  prospect_storage_unavailable: 'L’enregistrement des prospects ne s’est pas terminé normalement.',
  discovery_timeout: 'Le délai de recherche est dépassé.',
  request_interrupted: 'La recherche a été interrompue.',
  discovery_unavailable: 'La recherche est temporairement indisponible.',
  discovery_method_not_allowed: 'La demande de recherche n’est pas prise en charge par le service.',
  discovery_unauthorized: 'Reconnectez-vous avant de lancer une recherche de prospects.',
  discovery_configuration_invalid: 'Vérifiez la configuration du service de recherche avant de réessayer.',
  discovery_configuration_unavailable: 'Les réglages de recherche sont temporairement indisponibles.',
  discovery_targeting_required: 'Enregistrez les paramètres de pays et de langues avant de rechercher des prospects.',
  discovery_targeting_invalid: 'Corrigez les pays ou les langues dans les paramètres de recherche.',
  discovery_targeting_changed: 'Les pays ou les langues ont changé pendant la recherche. Vérifiez les paramètres avant de relancer.',
  discovery_provider_not_configured: 'La connexion au service de recherche n’est pas configurée.',
  discovery_provider_failed: 'Le service de recherche est temporairement indisponible.',
  discovery_provider_invalid: 'La réponse du service de recherche n’a pas pu être validée.',
  discovery_request_invalid: 'Vérifiez le texte, le type et la niche de la recherche.',
  discovery_search_invalid: 'Les résultats de recherche reçus n’ont pas pu être validés.',
  discovery_extraction_invalid: 'Les prospects proposés n’ont pas pu être validés.',
  discovery_storage_unavailable: 'L’enregistrement des prospects n’a pas pu être confirmé.',
  discovery_storage_unconfirmed: 'Le résultat de l’enregistrement des prospects n’a pas pu être confirmé.',
  discovery_deadline_exceeded: 'Le délai de recherche est dépassé.',
  discovery_cancelled: 'La recherche a été interrompue.',
} as const;
type KnownCode = keyof typeof messages;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= 0 && value <= DISCOVERY_BATCH_LIMIT && !Object.is(value, -0);

/** Only local messages and validated receipt metadata escape the transport boundary. */
export class PartnerDiscoveryError extends Error {
  constructor(
    readonly status: FailureStatus = 'unknown',
    readonly confirmedInserted: number | null = null,
    readonly code: KnownCode | null = null,
  ) {
    const reason = code === null ? 'Le résultat de la recherche n’a pas pu être confirmé.' : messages[code];
    const confirmed = confirmedInserted === null ? 'Le nombre de prospects enregistrés n’est pas confirmé.'
      : confirmedInserted === 0 ? 'Cette réponse ne confirme aucun ajout.'
      : confirmedInserted === 1 ? '1 prospect est confirmé enregistré.'
      : `${confirmedInserted} prospects sont confirmés enregistrés.`;
    super(status === 'failed' ? reason
      : `${reason} ${confirmed} Vérifiez la liste des prospects avant de relancer.`);
    this.name = 'PartnerDiscoveryError';
  }
}

function parseFailure(value: unknown): PartnerDiscoveryError {
  if (!record(value) || typeof value.status !== 'string' || !['failed', 'partial', 'unknown'].includes(value.status)
    || !count(value.confirmed_inserted) || value.inserted !== value.confirmed_inserted
    || !Array.isArray(value.prospects) || value.prospects.length !== value.confirmed_inserted
    || (value.status === 'failed' && value.confirmed_inserted !== 0)
    || (value.status === 'partial' && value.confirmed_inserted === 0)) return new PartnerDiscoveryError();
  const code = typeof value.code === 'string' && Object.prototype.hasOwnProperty.call(messages, value.code)
    ? value.code as KnownCode : null;
  return new PartnerDiscoveryError(value.status as FailureStatus, value.confirmed_inserted, code);
}

/** Consume the original SDK error Response once: no clone/tee or unbounded json().
 * Failure to decode remains unknown because the server may already have written. */
export async function readPartnerDiscoveryError(error: unknown): Promise<PartnerDiscoveryError> {
  if (error instanceof PartnerDiscoveryError) return error;
  const response = (error instanceof FunctionsHttpError || error instanceof FunctionsRelayError)
    && error.context instanceof Response ? error.context as Response : null;
  if (response === null) return new PartnerDiscoveryError();
  try {
    if (!(error instanceof FunctionsHttpError) || response.ok || response.bodyUsed
      || !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) {
      return new PartnerDiscoveryError();
    }
    const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
    const bytes = await readBoundedBytes({
      body: response.body, headers: response.headers, signal: new AbortController().signal,
    }, {
      maxBytes: 16 * 1024, deadline: performance.now() + 1_000,
      matchContentLength: !encoding || encoding === 'identity',
    });
    return parseFailure(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    return new PartnerDiscoveryError();
  } finally {
    cancelResponseQuietly(response.body);
  }
}

/** The refreshed list remains authoritative for prospect details. */
export function parsePartnerDiscoveryResult(value: unknown): { inserted: number; skipped?: number; prospects: PartnerProspect[] } {
  if (!record(value) || !count(value.inserted) || !Array.isArray(value.prospects)
    || value.prospects.length !== value.inserted || !value.prospects.every(record)
    || (value.skipped !== undefined && (!count(value.skipped) || value.inserted + value.skipped > DISCOVERY_BATCH_LIMIT))
    || value.status !== undefined || value.error !== undefined) throw new PartnerDiscoveryError();
  return { inserted: value.inserted,
    ...(typeof value.skipped === 'number' ? { skipped: value.skipped } : {}),
    prospects: value.prospects as unknown as PartnerProspect[],
  };
}

export function partnerDiscoveryFeedback(error: unknown): {
  kind: 'error' | 'warning'; title: string; description: string; refreshList: boolean;
} {
  const failure = error instanceof PartnerDiscoveryError ? error : new PartnerDiscoveryError();
  return {
    kind: failure.status === 'failed' ? 'error' : 'warning',
    title: failure.status === 'partial' ? 'Recherche partiellement enregistrée'
      : failure.status === 'unknown' ? 'Recherche à vérifier' : 'Erreur recherche',
    description: failure.message,
    refreshList: failure.status !== 'failed',
  };
}
