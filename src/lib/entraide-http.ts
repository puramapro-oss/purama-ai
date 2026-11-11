/** Transport commun des quatre fonctions Entraide. Aucune erreur brute du serveur n'est affichée. */
export class EntraideHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'EntraideHttpError';
  }
}

interface EntraideRequestOptions {
  token: string;
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  signal?: AbortSignal;
}

const ERROR_MESSAGES: Record<string, string> = {
  invalid_payload: 'Vérifie les champs du formulaire avant de réessayer.',
  invalid_request: 'Vérifie les champs du formulaire avant de réessayer.',
  invalid_body: 'Vérifie les champs du formulaire avant de réessayer.',
  revision_conflict: 'La mission a changé entre-temps. Actualise-la avant de recommencer.',
  stale_revision: 'La mission a changé entre-temps. Actualise-la avant de recommencer.',
  idempotency_conflict: 'Cette demande a déjà été utilisée avec un autre contenu. Modifie le formulaire pour créer une nouvelle demande.',
  mission_full: 'Cette mission a atteint son nombre maximal de participants.',
  mission_not_recruiting: 'Cette mission ne recrute plus de participants.',
  mission_closed: 'Cette mission est déjà clôturée.',
  not_ready: 'Le nombre minimal de participants doit être atteint avant le démarrage.',
  not_in_progress: 'Seule une mission en cours peut être déclarée terminée.',
  already_closed: 'Cette mission est déjà clôturée.',
  organizer_cannot_leave: 'L’organisateur peut annuler la mission, mais ne peut pas la quitter.',
  contact_expired: 'Cette demande de contact a expiré.',
  request_expired: 'Cette demande de contact a expiré.',
  contact_already_pending: 'Une demande de contact est déjà en attente avec ce membre.',
  already_pending: 'Une demande de contact est déjà en attente avec ce membre.',
  self_contact: 'Tu ne peux pas t’envoyer une demande de contact.',
  contact_unavailable: 'Ce contact n’est pas disponible. Tu peux consulter les autres suggestions.',
  contact_history_unavailable: 'Cette demande ne peut pas être renouvelée pour le moment.',
  request_not_pending: 'Cette demande a déjà reçu une réponse. Actualise tes contacts.',
  recipient_not_found: 'Ce membre n’est plus accessible dans le réseau.',
  request_not_found: 'Cette demande de contact n’est plus accessible.',
  daily_limit_reached: 'La limite de demandes de contact est atteinte. Réessaie plus tard.',
  cooldown_active: 'Une demande récente existe avec ce membre. Patiente avant d’en envoyer une autre.',
};

function errorMessage(status: number, code: string, retryAfterSeconds?: number): string {
  if (status === 401) return 'Ta session a expiré. Reconnecte-toi pour continuer.';
  if (status === 429) {
    const explanation = ERROR_MESSAGES[code] ?? 'Trop de demandes rapprochées.';
    return retryAfterSeconds === undefined
      ? `${explanation} ${ERROR_MESSAGES[code] ? '' : 'Patiente avant de réessayer.'}`.trim()
      : `${explanation} Réessaie dans ${retryAfterSeconds} s.`;
  }
  if (status >= 500) return 'Le service d’entraide est momentanément indisponible. Réessaie plus tard.';
  if (ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  if (status === 403) return 'Cette action n’est pas autorisée pour ton compte ou cette demande.';
  if (status === 404) return 'Cette mission ou demande de contact n’est plus accessible.';
  if (status === 409) return 'Les données ont changé ou cette demande existe déjà. Actualise avant de réessayer.';
  if (status === 410) return 'Cette demande a expiré et ne peut plus être utilisée.';
  if (status === 400 || status === 422) return 'Vérifie les champs du formulaire avant de réessayer.';
  return 'La demande n’a pas pu être confirmée. Réessaie plus tard.';
}

export async function requestEntraide<T>(
  route: string,
  { token, method = 'GET', body, signal }: EntraideRequestOptions,
): Promise<T> {
  const accessToken = token?.trim().replace(/^Bearer\s+/i, '');
  if (!accessToken) {
    throw new EntraideHttpError('Connecte-toi pour accéder au réseau d’entraide.', 401, 'unauthenticated');
  }

  // Refuser les URL absolues et traversées de chemin pour ne jamais envoyer le jeton hors de ce service.
  if (!/^entraide-(profil|matches|missions|contact)(?:\/[a-zA-Z0-9_-]+)*$/.test(route)) {
    throw new EntraideHttpError('Cette action d’entraide n’est pas disponible.', 400, 'invalid_route');
  }

  const baseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
  const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() || import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!baseUrl || !anonKey) {
    throw new EntraideHttpError('Le service d’entraide n’est pas configuré. Réessaie lorsque sa configuration sera disponible.', 503, 'missing_configuration');
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!localHttp && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid_configuration');
    }
    url.pathname = `${url.pathname.replace(/\/$/, '')}/functions/v1/${route}`;
  } catch {
    throw new EntraideHttpError('La configuration du service d’entraide est invalide.', 503, 'invalid_configuration');
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: anonKey,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      redirect: 'error',
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw new EntraideHttpError('La réponse n’a pas pu être confirmée. Vérifie ta connexion, puis réessaie.', 0, 'network_error');
  }

  const payload: unknown = await response.json().catch((error) => {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    return null;
  });
  if (!response.ok) {
    const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const rawCode = typeof record.code === 'string' ? record.code : record.error;
    const code = typeof rawCode === 'string' && /^[a-z_]{1,80}$/.test(rawCode) ? rawCode : 'request_failed';
    const retryHeader = response.headers.get('Retry-After');
    const retrySeconds = retryHeader !== null && /^\d+$/.test(retryHeader) ? Number(retryHeader) : NaN;
    const retryAfterSeconds = Number.isSafeInteger(retrySeconds) ? retrySeconds : undefined;
    throw new EntraideHttpError(errorMessage(response.status, code, retryAfterSeconds), response.status, code, retryAfterSeconds);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || 'error' in payload || ('ok' in payload && payload.ok !== true)) {
    throw new EntraideHttpError('Le service a renvoyé une réponse invalide. La demande n’a pas pu être confirmée.', 502, 'invalid_response');
  }
  return payload as T;
}
