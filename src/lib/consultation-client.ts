import type {
  ConsultationCatalog, ConsultationInput, ConsultationOperation, ConsultationPublicPlan,
  ConsultationPublicResult, ConsultationReflection, ConsultationSpeed,
} from '../../karta/src/api/consultation-contract';

export type { ConsultationCatalog, ConsultationInput, ConsultationOperation, ConsultationPublicPlan };
export const CONSULTATION_MAX_REQUEST_BYTES = 65_536;

const reflections = ['auto', 'standard', 'deep', 'maximum'] as const;
const speeds = ['standard', 'fast', 'ultra_fast'] as const;
const reasons = ['ready', 'not_configured', 'simulation_enabled', 'account_unavailable', 'budget_unavailable', 'model_unavailable', 'paused', 'service_unavailable'];
const statuses = ['running', 'complete', 'partial', 'failed', 'blocked', 'cancelled', 'reconciliation_required'];
const resultReasons = ['completed', 'some_calls_unavailable', 'synthesis_unavailable', 'already_claimed', 'interrupted', 'accounting_unavailable'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && UUID.test(value);
const id = (value: unknown, maximum = 200): value is string => typeof value === 'string' && value.length > 0
  && value.length <= maximum && /^[A-Za-z0-9]/.test(value) && !/[^A-Za-z0-9._:/-]/.test(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value)
  && Number(value) >= min && Number(value) <= max;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const values = (value: unknown, allowed: readonly string[], max = allowed.length): value is string[] => Array.isArray(value)
  && value.length <= max && value.every(item => typeof item === 'string' && allowed.includes(item)) && new Set(value).size === value.length;

export class ConsultationClientError extends Error {
  constructor(readonly code: 'invalid' | 'authentication' | 'forbidden' | 'conflict' | 'budget' | 'rate_limit' | 'not_found' | 'timeout' | 'interrupted' | 'unavailable') {
    const messages = {
      invalid: 'Les données de consultation sont invalides.',
      authentication: 'Connectez-vous pour utiliser la consultation.',
      forbidden: 'Cette consultation n’est pas accessible à ce compte.',
      conflict: 'Cette demande correspond déjà à un autre contenu. Consultez son état.',
      budget: 'La capacité disponible ne permet pas cette consultation.',
      rate_limit: 'Trop de demandes ont été envoyées. Patientez avant de vérifier le résultat.',
      not_found: 'Cette consultation est introuvable pour ce compte.',
      timeout: 'Le délai de réponse est dépassé. Vérifiez le résultat avant une autre demande.',
      interrupted: 'La connexion a été interrompue. Vérifiez l’état de la consultation.',
      unavailable: 'Le service de consultation est temporairement indisponible.',
    };
    super(messages[code]);
  }
}
const invalid = (): never => { throw new ConsultationClientError('invalid'); };

function limits(value: unknown): ConsultationPublicPlan['research'] {
  if (!record(value) || !keys(value, ['maxSearches', 'maxPages', 'maxReviewers', 'maxRounds', 'concurrency'])
    || !integer(value.maxSearches, 0, 3) || !integer(value.maxPages, 0, 6) || !integer(value.maxReviewers, 0, 3)
    || !integer(value.maxRounds, 1, 2) || !integer(value.concurrency, 1, 3)) return invalid();
  return { maxSearches: value.maxSearches, maxPages: value.maxPages, maxReviewers: value.maxReviewers,
    maxRounds: value.maxRounds, concurrency: value.concurrency };
}

function plan(value: unknown): ConsultationPublicPlan {
  if (!record(value) || !keys(value, ['model', 'reflection', 'speed', 'maxOutputTokens', 'timeoutMs', 'research'])
    || !id(value.model) || typeof value.reflection !== 'string' || !['standard', 'deep', 'maximum'].includes(value.reflection)
    || !speeds.includes(value.speed as ConsultationSpeed) || !integer(value.maxOutputTokens, 1024, 65536)
    || !integer(value.timeoutMs, 1, 120000)) return invalid();
  return { model: value.model, reflection: value.reflection as ConsultationPublicPlan['reflection'],
    speed: value.speed as ConsultationSpeed, maxOutputTokens: value.maxOutputTokens, timeoutMs: value.timeoutMs,
    research: limits(value.research) };
}

function catalog(value: unknown): ConsultationCatalog {
  if (!record(value) || !keys(value, ['available', 'reason', 'models', 'research'])
    || typeof value.available !== 'boolean' || typeof value.reason !== 'string' || !reasons.includes(value.reason)
    || !Array.isArray(value.models) || value.models.length > 32 || !record(value.research)
    || !keys(value.research, ['search', 'scrape']) || typeof value.research.search !== 'boolean' || typeof value.research.scrape !== 'boolean') return invalid();
  const models = value.models.map(row => {
    if (!record(row) || !keys(row, ['model', 'provider', 'reflections', 'speeds', 'maxOutputTokens', 'profiles'])
      || !id(row.model) || !id(row.provider) || !values(row.reflections, reflections) || row.reflections.length === 0
      || !values(row.speeds, speeds) || row.speeds.length === 0 || !integer(row.maxOutputTokens, 1024, 65536)
      || !Array.isArray(row.profiles) || row.profiles.length === 0 || row.profiles.length > 12) return invalid();
    const supportedReflections = row.reflections;
    const supportedSpeeds = row.speeds;
    const profiles = row.profiles.map(profile => {
      if (!record(profile) || !keys(profile, ['reflection', 'speed', 'research'])
        || !supportedReflections.includes(profile.reflection as string) || !supportedSpeeds.includes(profile.speed as string)) return invalid();
      return { reflection: profile.reflection as ConsultationReflection, speed: profile.speed as ConsultationSpeed, research: limits(profile.research) };
    });
    if (new Set(profiles.map(profile => `${profile.reflection}/${profile.speed}`)).size !== profiles.length) return invalid();
    return { model: row.model, provider: row.provider, reflections: row.reflections as ConsultationReflection[],
      speeds: row.speeds as ConsultationSpeed[], maxOutputTokens: row.maxOutputTokens, profiles };
  });
  if (new Set(models.map(model => model.model)).size !== models.length
    || (value.available && (value.reason !== 'ready' || !models.length)) || (!value.available && value.reason === 'ready')) return invalid();
  return { available: value.available, reason: value.reason as ConsultationCatalog['reason'], models,
    research: { search: value.research.search, scrape: value.research.scrape } };
}

/** Only navigable HTTPS links; never render a provider URL as HTML. */
export function consultationSourceUrl(value: unknown): string | null {
  if (!text(value, 8192) || value.trim() !== value || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || url.hostname === 'localhost') return null;
    return url.href;
  } catch { return null; }
}

function result(value: unknown): ConsultationPublicResult | null {
  if (value === null) return null;
  if (!record(value) || !keys(value, ['status', 'reason', 'plan', 'answer', 'citedSourceIds', 'disagreements', 'uncertainties', 'sources', 'verificationStatus'])
    || typeof value.status !== 'string' || !['complete', 'partial', 'failed', 'blocked'].includes(value.status)
    || typeof value.reason !== 'string' || !resultReasons.includes(value.reason)
    || value.verificationStatus !== 'unverified' || (value.answer !== null && (!text(value.answer, 32000) || !value.answer.trim()))
    || !Array.isArray(value.sources) || value.sources.length > 32) return invalid();
  for (const name of ['citedSourceIds', 'disagreements', 'uncertainties']) {
    const list = value[name];
    if (!Array.isArray(list) || list.length > 32 || list.some(item => !text(item, 2000) || !item.trim())) return invalid();
  }
  let total = 0;
  const sources = value.sources.map(source => {
    if (!record(source) || !keys(source, ['id', 'provider', 'retrievedAt', 'url', 'title', 'text', 'contentKind', 'verificationStatus', 'truncated'])
      || !id(source.id) || !id(source.provider) || !text(source.retrievedAt, 40) || !Number.isFinite(Date.parse(source.retrievedAt))
      || !consultationSourceUrl(source.url) || !text(source.title, 512) || !text(source.text, 2000)
      || typeof source.contentKind !== 'string' || !['search_excerpt', 'page_markdown'].includes(source.contentKind)
      || source.verificationStatus !== 'unverified' || typeof source.truncated !== 'boolean') return invalid();
    total += source.text.length;
    return { id: source.id, provider: source.provider, retrievedAt: source.retrievedAt, url: source.url as string,
      title: source.title, text: source.text, contentKind: source.contentKind as 'search_excerpt' | 'page_markdown',
      verificationStatus: 'unverified' as const, truncated: source.truncated };
  });
  const citedSourceIds = value.citedSourceIds as string[];
  if (((value.status === 'complete' || value.status === 'partial') !== (value.answer !== null))
    || total > 32000 || new Set(sources.map(source => source.id)).size !== sources.length
    || new Set(citedSourceIds).size !== citedSourceIds.length || citedSourceIds.some(sourceId => !sources.some(source => source.id === sourceId))) return invalid();
  return { status: value.status as ConsultationPublicResult['status'], reason: value.reason as ConsultationPublicResult['reason'],
    plan: plan(value.plan), answer: value.answer as string | null, citedSourceIds,
    disagreements: value.disagreements as string[], uncertainties: value.uncertainties as string[], sources, verificationStatus: 'unverified' };
}

function operation(value: unknown, expectedId: string): ConsultationOperation | null {
  if (value === null) return null;
  if (!record(value) || !keys(value, ['operationId', 'status', 'cancelRequested', 'result'])
    || value.operationId !== expectedId || typeof value.status !== 'string' || !statuses.includes(value.status) || typeof value.cancelRequested !== 'boolean') return invalid();
  const output = result(value.result);
  if ((value.status === 'complete' || value.status === 'partial') && output?.status !== value.status) return invalid();
  return { operationId: expectedId, status: value.status as ConsultationOperation['status'], cancelRequested: value.cancelRequested, result: output };
}

function input(value: ConsultationInput): ConsultationInput {
  if (!record(value) || !keys(value, ['operationId', 'question', 'preferences', 'reviewerModels', 'research'])
    || !uuid(value.operationId) || !text(value.question, 8000) || !value.question.trim()
    || !record(value.preferences) || !keys(value.preferences, ['model', 'reflection', 'speed']) || !id(value.preferences.model)
    || (value.preferences.reflection !== undefined && !reflections.includes(value.preferences.reflection))
    || (value.preferences.speed !== undefined && !speeds.includes(value.preferences.speed))) return invalid();
  const reviewerModels = value.reviewerModels ?? [];
  const research = value.research ?? { queries: [], urls: [] };
  if (!Array.isArray(reviewerModels) || reviewerModels.length > 3 || reviewerModels.some(model => !id(model) || model === value.preferences.model)
    || new Set(reviewerModels).size !== reviewerModels.length || !record(research) || !keys(research, ['queries', 'urls'])
    || !Array.isArray(research.queries) || research.queries.length > 3 || research.queries.some(query => !text(query, 2000) || !query.trim())
    || !Array.isArray(research.urls) || research.urls.length > 6 || research.urls.some(url => !consultationSourceUrl(url))) return invalid();
  return { operationId: value.operationId.toLowerCase(), question: value.question, preferences: { ...value.preferences },
    reviewerModels: [...reviewerModels], research: { queries: [...research.queries], urls: [...research.urls] } };
}

export interface ConsultationClient {
  catalog(signal?: AbortSignal): Promise<ConsultationCatalog>;
  consult(value: ConsultationInput, signal?: AbortSignal): Promise<ConsultationOperation>;
  status(operationId: string, signal?: AbortSignal): Promise<ConsultationOperation | null>;
  cancel(operationId: string, signal?: AbortSignal): Promise<ConsultationOperation | null>;
}

/** Bound UTF-8 bytes before parsing, including error responses. */
async function readResponse(response: Response, signal?: AbortSignal): Promise<unknown> {
  const discard = () => { try { void response.body?.cancel().catch(() => {}); } catch { /* Best effort. */ } };
  const length = response.headers.get('Content-Length');
  if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
    || (length !== null && (!/^\d+$/.test(length) || Number(length) > 524_288))) { discard(); return invalid(); }
  const reader = response.body?.getReader();
  if (!reader) return invalid();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      signal?.throwIfAborted();
      const part = await reader.read();
      signal?.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 524_288) return invalid();
      chunks.push(part.value);
    }
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)); } catch { return invalid(); }
  } finally { try { void reader.cancel().catch(() => {}); } catch { /* Best effort. */ } }
}

/** Capture the account token; no mutable SDK session can substitute another
 * account. Only the configured public Edge endpoint receives this token. */
export function createConsultationClient(accessToken: string): ConsultationClient {
  if (!text(accessToken, 8192) || !accessToken || /\s/.test(accessToken)) throw new ConsultationClientError('authentication');
  let endpoint: string | null = null;
  const publicKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  try {
    const base = new URL(import.meta.env.VITE_SUPABASE_URL);
    if (base.protocol === 'https:' && !base.username && !base.password && !base.search && !base.hash
      && typeof publicKey === 'string' && publicKey.length > 0 && publicKey.length <= 8192 && !/\s/.test(publicKey)) {
      endpoint = `${base.href.replace(/\/$/, '')}/functions/v1/iao-consultation`;
    }
  } catch { /* Missing configuration is unavailable, never a relative URL. */ }
  const invoke = async (body: Record<string, unknown>, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!endpoint) throw new ConsultationClientError('unavailable');
    const encoded = JSON.stringify(body);
    if (new TextEncoder().encode(encoded).byteLength > CONSULTATION_MAX_REQUEST_BYTES) return invalid();
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST', body: encoded, signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', apikey: publicKey,
          Authorization: `Bearer ${accessToken}` },
      });
    } catch { signal?.throwIfAborted(); throw new ConsultationClientError('unavailable'); }
    if (signal?.aborted) { try { void response.body?.cancel().catch(() => {}); } catch { /* Best effort. */ } signal.throwIfAborted(); }
    if (response.redirected) { try { void response.body?.cancel().catch(() => {}); } catch { /* Best effort. */ } return invalid(); }
    let data: unknown;
    try { data = await readResponse(response, signal); }
    catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ConsultationClientError) throw error;
      throw new ConsultationClientError('unavailable');
    }
    if (!response.ok) {
      const status = response.status;
      const rateLimited = record(data) && data.code === 'IAO_RATE_LIMIT';
      const code = status === 401 ? 'authentication' : status === 403 ? 'forbidden' : status === 404 ? 'not_found'
        : status === 409 ? 'conflict' : status === 429 ? (rateLimited ? 'rate_limit' : 'budget')
          : status === 499 ? 'interrupted' : status === 504 ? 'timeout' : status === 400 || status === 413 ? 'invalid' : 'unavailable';
      throw new ConsultationClientError(code);
    }
    if (![200, 202].includes(response.status) || !record(data) || data.ok !== true) return invalid();
    return data;
  };
  const lookup = async (action: 'status' | 'cancel', operationId: string, signal?: AbortSignal) => {
    if (!uuid(operationId)) return invalid();
    const normalizedId = operationId.toLowerCase();
    const data = await invoke({ action, operationId: normalizedId }, signal);
    if (!keys(data, ['ok', 'operation'])) return invalid();
    return operation(data.operation, normalizedId);
  };
  return {
    async catalog(signal) { const data = await invoke({ action: 'catalog' }, signal); if (!keys(data, ['ok', 'catalog'])) return invalid(); return catalog(data.catalog); },
    async consult(value, signal) {
      const request = input(value);
      const data = await invoke({ action: 'consult', ...request }, signal);
      if (!keys(data, ['ok', 'operation'])) return invalid();
      const received = operation(data.operation, request.operationId);
      return received ?? invalid();
    },
    status: (operationId, signal) => lookup('status', operationId, signal),
    cancel: (operationId, signal) => lookup('cancel', operationId, signal),
  };
}
