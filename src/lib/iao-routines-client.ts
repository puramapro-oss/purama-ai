import { supabase } from '@/integrations/supabase/client';
import { normalizeRoutineInput, normalizeRoutineTimestamp, type Routine, type RoutineInput } from '../../karta/src/routines/contracts';

export type { Routine, RoutineInput };
export type RoutineChannel = RoutineInput['channels'][number];

export interface RoutineCapabilities {
  routines: boolean;
  calls: boolean;
  verifiedPhone: string | null;
  phoneBlockedReason: string | null;
  voiceCommands: 'confirmation_required';
  email: boolean;
  push: boolean;
  agents: Array<{ type: string; name: string }>;
}

export interface RoutineOccurrence {
  id: string;
  routineId: string;
  scheduledAt: string;
  status: string;
  report: { title: string; body: string } | null;
  deliveries: Array<{ channel: RoutineChannel; status: string }>;
}

export interface RoutineCommand {
  id: string;
  occurrenceId: string;
  instruction: string;
  status: 'pending_confirmation' | 'submitted' | 'cancelled';
  createdAt: string;
}

export interface RoutineList {
  routines: Routine[];
  capabilities: RoutineCapabilities;
  history: RoutineOccurrence[];
  commands: RoutineCommand[];
}

export interface RoutineRequests {
  list: Record<string, never>;
  preview: { config: RoutineInput };
  save: { id: string; expectedRevision: number; config: RoutineInput };
  pause: { id: string; expectedRevision: number; pausedUntil: string | null; enabled?: boolean };
  'pause-all': Record<string, never>;
  'run-now': { id: string; expectedRevision: number; requestId: string };
  cancel: { occurrenceId: string };
}

export interface RoutineResults {
  list: RoutineList;
  preview: { occurrences: string[] };
  save: { routine: Routine };
  pause: { routine: Routine };
  'pause-all': { updatedCount: number };
  'run-now': { occurrence: RoutineOccurrence };
  cancel: { occurrenceId: string; warning: string };
}

export interface RoutineClientSession {
  ownerId: string;
  accessToken: string;
  current(): boolean;
  signal?: AbortSignal;
}

export class RoutineClientError extends Error {
  constructor(message: string, readonly uncertain = false) {
    super(message);
    this.name = 'RoutineClientError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNELS = new Set(['call', 'in_app', 'push', 'email']);
const OCCURRENCE_STATES = new Set(['pending', 'processing', 'completed', 'cancelled', 'skipped', 'failed', 'partial', 'unknown']);
const DELIVERY_STATES = new Set(['pending', 'sending', 'accepted', 'completed', 'failed', 'unknown', 'skipped']);
const COMMAND_STATES = new Set(['pending_confirmation', 'submitted', 'cancelled']);
const invalid = () => new RoutineClientError('Réponse du service non confirmée. Actualisez les routines avant de réessayer.', true);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0');
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));

function ownedRoutine(value: unknown, ownerId: string): Routine {
  if (!object(value) || !uuid(value.id) || value.userId !== ownerId
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || !timestamp(value.createdAt) || !timestamp(value.updatedAt)
    || (value.lastOccurrenceAt !== null && !timestamp(value.lastOccurrenceAt))) throw invalid();
  let config: RoutineInput;
  try { config = normalizeRoutineInput(value.config); } catch { throw invalid(); }
  return { id: value.id, userId: ownerId, revision: Number(value.revision), config,
    createdAt: value.createdAt, updatedAt: value.updatedAt, lastOccurrenceAt: value.lastOccurrenceAt as string | null };
}

function occurrence(value: unknown, detailed: boolean): RoutineOccurrence {
  if (!object(value) || !uuid(value.id) || !uuid(value.routineId) || !timestamp(value.scheduledAt)
    || typeof value.status !== 'string' || !OCCURRENCE_STATES.has(value.status)) throw invalid();
  const suppliedReport = value.report ?? null;
  let report: RoutineOccurrence['report'] = null;
  if (suppliedReport !== null) {
    if (!object(suppliedReport)) throw invalid();
    const title = suppliedReport.title;
    const body = suppliedReport.body;
    if (!text(title, 300) || !text(body, 20_000)) throw invalid();
    report = { title, body };
  }
  const rows = value.deliveries ?? (detailed ? undefined : []);
  if (!Array.isArray(rows) || rows.length > 4) throw invalid();
  const seen = new Set<string>();
  const deliveries = rows.map(row => {
    if (!object(row) || typeof row.channel !== 'string' || !CHANNELS.has(row.channel)
      || seen.has(row.channel) || typeof row.status !== 'string' || !DELIVERY_STATES.has(row.status)) throw invalid();
    seen.add(row.channel);
    return { channel: row.channel as RoutineChannel, status: row.status };
  });
  return { id: value.id, routineId: value.routineId, scheduledAt: value.scheduledAt, status: value.status,
    report, deliveries };
}

function command(value: unknown): RoutineCommand {
  if (!object(value) || !uuid(value.id) || !uuid(value.occurrenceId) || !text(value.instruction, 8_000)
    || !value.instruction.trim() || typeof value.status !== 'string' || !COMMAND_STATES.has(value.status)
    || !timestamp(value.createdAt)) throw invalid();
  return { id: value.id, occurrenceId: value.occurrenceId, instruction: value.instruction,
    status: value.status as RoutineCommand['status'], createdAt: value.createdAt };
}

function listResult(data: Record<string, unknown>, ownerId: string): RoutineList {
  const cap = data.capabilities;
  if (!Array.isArray(data.routines) || data.routines.length > 100 || !object(cap)
    || ['routines', 'calls', 'email', 'push'].some(key => typeof cap[key] !== 'boolean')
    || (cap.verifiedPhone !== null && !text(cap.verifiedPhone, 64))
    || (cap.phoneBlockedReason != null && !text(cap.phoneBlockedReason, 300))
    || cap.voiceCommands !== 'confirmation_required' || !Array.isArray(cap.agents) || cap.agents.length > 100
    || !Array.isArray(data.history) || data.history.length > 20) throw invalid();
  const routines = data.routines.map(row => ownedRoutine(row, ownerId));
  if (new Set(routines.map(row => row.id)).size !== routines.length) throw invalid();
  const agents = cap.agents.map(row => {
    if (!object(row) || !text(row.type, 100) || !text(row.name, 100) || !row.type.trim() || !row.name.trim()) throw invalid();
    return { type: row.type, name: row.name };
  });
  const history = data.history.map(row => occurrence(row, true));
  if (new Set(history.map(row => row.id)).size !== history.length) throw invalid();
  const rawCommands = data.commands ?? [];
  if (!Array.isArray(rawCommands) || rawCommands.length > 50) throw invalid();
  return { routines, history, commands: rawCommands.map(command), capabilities: {
    routines: cap.routines as boolean, calls: cap.calls as boolean, verifiedPhone: cap.verifiedPhone as string | null,
    phoneBlockedReason: cap.phoneBlockedReason as string | null ?? null,
    voiceCommands: 'confirmation_required', email: cap.email as boolean, push: cap.push as boolean, agents,
  } };
}

function requestBody<A extends keyof RoutineRequests>(action: A, payload: RoutineRequests[A]): Record<string, unknown> {
  const required: Record<keyof RoutineRequests, string[]> = {
    list: [], preview: ['config'], save: ['id', 'expectedRevision', 'config'],
    pause: ['id', 'expectedRevision', 'pausedUntil'], 'pause-all': [],
    'run-now': ['id', 'expectedRevision', 'requestId'], cancel: ['occurrenceId'],
  };
  if (!object(payload) || !hasOwn(required, action) || required[action].some(key => !hasOwn(payload, key))
    || Object.keys(payload).some(key => !required[action].includes(key) && !(action === 'pause' && key === 'enabled'))) {
    throw new RoutineClientError('La demande de routine est invalide.');
  }
  const result: Record<string, unknown> = { action, ...payload };
  for (const key of ['id', 'requestId', 'occurrenceId']) {
    if (hasOwn(result, key) && !uuid(result[key])) throw new RoutineClientError('Identité de demande invalide.');
  }
  if (hasOwn(result, 'expectedRevision') && (!Number.isSafeInteger(result.expectedRevision)
    || Number(result.expectedRevision) < (action === 'save' ? 0 : 1))) throw new RoutineClientError('Version de routine invalide.');
  try {
    if (hasOwn(result, 'config')) result.config = normalizeRoutineInput(result.config);
    if (hasOwn(result, 'pausedUntil') && result.pausedUntil !== null) result.pausedUntil = normalizeRoutineTimestamp(result.pausedUntil);
  } catch { throw new RoutineClientError('Vérifiez les réglages de la routine.'); }
  if (hasOwn(result, 'enabled') && typeof result.enabled !== 'boolean') throw new RoutineClientError('Activation invalide.');
  return result;
}

/** The supplied token belongs to the captured session; invoke must not pick a later account's token. */
export async function requestIaoRoutines<A extends keyof RoutineRequests>(
  action: A, payload: RoutineRequests[A], session: RoutineClientSession,
): Promise<RoutineResults[A]> {
  if (!uuid(session.ownerId) || !session.accessToken || !session.current() || session.signal?.aborted) {
    throw new RoutineClientError('La session a changé. Rechargez vos routines.');
  }
  const mutating = !['list', 'preview'].includes(action);
  const body = requestBody(action, payload);
  let result: { data: unknown; error: unknown };
  try {
    result = await supabase.functions.invoke('iao-routines', {
      body, headers: { Authorization: `Bearer ${session.accessToken}` },
      signal: session.signal, timeout: 12_000,
    });
  } catch {
    throw new RoutineClientError(mutating
      ? 'Résultat non confirmé. Actualisez l’historique avant de réessayer.'
      : 'Le service est momentanément indisponible. Réessayez.', mutating);
  }
  if (!session.current() || session.signal?.aborted) throw new RoutineClientError('La session a changé. Rechargez vos routines.');
  if (result.error) {
    const status = object(result.error) && object(result.error.context) ? result.error.context.status : undefined;
    const message = status === 401 ? 'Votre session a expiré. Reconnectez-vous.'
      : status === 409 ? 'Ces réglages ont changé. Actualisez les routines avant de les modifier.'
        : status === 400 ? 'Vérifiez les réglages et les canaux disponibles.'
          : status === 403 ? 'Cette opération n’est pas autorisée pour votre compte.'
            : status === 429 ? 'Trop de demandes. Patientez avant de réessayer.'
              : mutating ? 'Résultat non confirmé. Actualisez l’historique avant de réessayer.'
                : 'Le service est momentanément indisponible. Réessayez.';
    throw new RoutineClientError(message, mutating && ![400, 401, 403, 409, 429].includes(Number(status)));
  }
  const data = result.data;
  if (!object(data) || data.ok !== true) throw invalid();
  let parsed: RoutineResults[keyof RoutineResults];
  switch (action) {
    case 'list': parsed = listResult(data, session.ownerId); break;
    case 'save':
    case 'pause': {
      const routine = ownedRoutine(data.routine, session.ownerId);
      const expectedRevision = Number(body.expectedRevision);
      // An identical write is a confirmed no-op; SQL keeps its revision unchanged.
      if (routine.id !== body.id || (routine.revision !== expectedRevision + 1
        && !(expectedRevision > 0 && routine.revision === expectedRevision))) throw invalid();
      if (action === 'save' && JSON.stringify(routine.config) !== JSON.stringify(body.config)) throw invalid();
      if (action === 'pause' && (routine.config.pausedUntil !== body.pausedUntil
        || (hasOwn(body, 'enabled') && routine.config.enabled !== body.enabled))) throw invalid();
      parsed = { routine }; break;
    }
    case 'preview': {
      if (!Array.isArray(data.occurrences) || data.occurrences.length > 3 || !data.occurrences.every(timestamp)
        || data.occurrences.some((at, index) => index > 0 && Date.parse(at) <= Date.parse(data.occurrences[index - 1]))) throw invalid();
      parsed = { occurrences: data.occurrences }; break;
    }
    case 'run-now': {
      const item = occurrence(data.occurrence, false);
      if (item.routineId !== (payload as RoutineRequests['run-now']).id) throw invalid();
      parsed = { occurrence: item }; break;
    }
    case 'pause-all': {
      if (!Number.isSafeInteger(data.updatedCount) || Number(data.updatedCount) < 0) throw invalid();
      parsed = { updatedCount: Number(data.updatedCount) }; break;
    }
    case 'cancel': {
      if (data.cancelled !== true || data.occurrenceId !== (payload as RoutineRequests['cancel']).occurrenceId) throw invalid();
      parsed = { occurrenceId: data.occurrenceId as string,
        warning: 'Les envois encore en attente sont annulés. Un appel déjà transmis peut continuer.' }; break;
    }
    default: throw invalid();
  }
  return parsed as RoutineResults[A];
}
