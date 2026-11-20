import { json } from './response.ts';
import { rateLimit } from './rate-limit.ts';

export type EntraideRoute = 'entraide-profil' | 'entraide-matches' | 'entraide-missions' | 'entraide-contact';
export type Payload = Record<string, unknown>;
export interface EntraidePorts {
  authenticate(header: string): Promise<{ id: string } | null>;
  getProfile(actor: string): Promise<Payload | null>;
  saveProfile(actor: string, payload: Payload): Promise<void>;
  getMatches(actor: string): Promise<Payload>;
  command(kind: 'contact' | 'mission', actor: string, action: string, payload: Payload): Promise<unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const MAX_BODY_BYTES = 16_384;

class RequestError extends Error {
  status: number;
  constructor(code: string, status = 400) { super(code); this.status = status; }
}

function object(value: unknown): value is Payload {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Payload, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new RequestError('invalid_payload');
}

function uuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

async function readBody(req: Request): Promise<Payload> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '')) {
    throw new RequestError('invalid_request', 415);
  }
  const length = Number(req.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new RequestError('payload_too_large', 413);
  const reader = req.body?.getReader();
  if (!reader) throw new RequestError('invalid_json');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RequestError('payload_too_large', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new RequestError('invalid_json'); }
  if (!object(value)) throw new RequestError('invalid_payload');
  return value;
}

function profilePayload(input: Payload): Payload {
  onlyKeys(input, ['skills_offered', 'skills_needed', 'availability_days', 'radius_km', 'location_lat', 'location_lng']);
  if (Object.keys(input).length === 0) throw new RequestError('invalid_payload');
  const result: Payload = {};
  for (const key of ['skills_offered', 'skills_needed']) {
    if (key in input) {
      const values = input[key];
      if (!Array.isArray(values) || values.length > 50 || values.some(v => typeof v !== 'string' || !v.trim() || v.trim().length > 100)) {
        throw new RequestError('invalid_payload');
      }
      result[key] = [...new Set(values.map(v => (v as string).trim()))];
    }
  }
  if ('availability_days' in input) {
    const values = input.availability_days;
    if (!Array.isArray(values) || values.length > 7 || values.some(v => typeof v !== 'string' || !DAYS.has(v))) throw new RequestError('invalid_payload');
    result.availability_days = [...new Set(values)];
  }
  if ('radius_km' in input) {
    if (input.radius_km !== null && !integer(input.radius_km, 0, 20_000)) throw new RequestError('invalid_payload');
    result.radius_km = input.radius_km;
  }
  if ('location_lat' in input || 'location_lng' in input) {
    const lat = input.location_lat; const lng = input.location_lng;
    const cleared = lat === null && lng === null;
    const valid = typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90 &&
      typeof lng === 'number' && Number.isFinite(lng) && Math.abs(lng) <= 180;
    if (!cleared && !valid) throw new RequestError('invalid_payload');
    result.location_lat = lat; result.location_lng = lng;
  }
  return result;
}

function missionPayload(input: Payload, action: string): Payload {
  if ('request_id' in input && !uuid(input.request_id)) throw new RequestError('invalid_payload');
  if (action !== 'create') {
    onlyKeys(input, ['request_id', 'expected_revision', 'expected_version']);
    // Transitional #17 writes translate at this boundary. SQL and current
    // clients use only revision; ambiguous dual preconditions are rejected.
    if ('expected_revision' in input && 'expected_version' in input) throw new RequestError('invalid_payload');
    if ('expected_version' in input && !integer(input.expected_version, 1, Number.MAX_SAFE_INTEGER)) throw new RequestError('invalid_payload');
    const revision = 'expected_version' in input ? Number(input.expected_version) - 1 : input.expected_revision;
    if (revision !== undefined && !integer(revision, 0, Number.MAX_SAFE_INTEGER)) throw new RequestError('invalid_payload');
    if (['start', 'complete', 'cancel', 'publish', 'unpublish'].includes(action) && revision === undefined) throw new RequestError('invalid_payload');
    return { ...('request_id' in input ? { request_id: input.request_id } : {}),
      ...(revision === undefined ? {} : { expected_revision: revision }) };
  }
  onlyKeys(input, ['id', 'request_id', 'title', 'description', 'min_participants', 'max_participants', 'visibility']);
  const id = input.id ?? input.request_id;
  if (!uuid(id) || typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 200 ||
    typeof input.description !== 'string' || input.description.length > 2000 || !integer(input.min_participants, 2, 1000) ||
    (input.max_participants != null && !integer(input.max_participants, input.min_participants, 1000)) ||
    !['private', 'public'].includes(String(input.visibility ?? 'private'))) throw new RequestError('invalid_payload');
  return { ...input, id, title: input.title.trim(), max_participants: input.max_participants ?? null, visibility: input.visibility ?? 'private' };
}

function contactPayload(input: Payload, action: string): Payload {
  if (action === 'send') {
    onlyKeys(input, ['id', 'recipient_id', 'message']);
    if (!uuid(input.id) || !uuid(input.recipient_id) ||
      (input.message != null && (typeof input.message !== 'string' || input.message.length > 500))) throw new RequestError('invalid_payload');
  } else if (action === 'respond') {
    onlyKeys(input, ['response']);
    if (!['accept', 'decline', 'block'].includes(String(input.response))) throw new RequestError('invalid_payload');
  } else {
    onlyKeys(input, ['target_id']);
    if (!uuid(input.target_id)) throw new RequestError('invalid_payload');
  }
  return input;
}

function resultTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
    hour <= 23 && minute <= 59 && second <= 59;
}

function missionResult(value: unknown, expectedId?: string): Payload {
  if (!object(value) || !uuid(value.id) || !uuid(value.organizer_id) ||
    (expectedId !== undefined && value.id.toLowerCase() !== expectedId.toLowerCase()) ||
    typeof value.title !== 'string' || typeof value.description !== 'string' ||
    !integer(value.min_participants, 2, 2_147_483_647) ||
    (value.max_participants !== null && !integer(value.max_participants, value.min_participants, 2_147_483_647)) ||
    typeof value.status !== 'string' || !['ouverte', 'prete', 'en_cours', 'terminee', 'annulee'].includes(value.status) ||
    !integer(value.revision, 0, Number.MAX_SAFE_INTEGER) ||
    (value.visibility !== 'private' && value.visibility !== 'public') ||
    !resultTimestamp(value.created_at) || !resultTimestamp(value.updated_at) ||
    !Array.isArray(value.missions_collectives_participants)) throw new Error('invalid_database_response');
  const participants = value.missions_collectives_participants.map(member => {
    if (!object(member) || !uuid(member.user_id) || !resultTimestamp(member.joined_at)) throw new Error('invalid_database_response');
    return { user_id: member.user_id, joined_at: member.joined_at };
  });
  // Reading historical rows must not invent membership or require today's quorum.
  // Whitelisting also keeps internal creation snapshots and future columns private.
  return {
    id: value.id, organizer_id: value.organizer_id, title: value.title, description: value.description,
    min_participants: value.min_participants, max_participants: value.max_participants,
    status: value.status, revision: value.revision, visibility: value.visibility,
    created_at: value.created_at, updated_at: value.updated_at,
    missions_collectives_participants: participants,
  };
}

function contactResult(value: unknown, expectedId?: string): Payload {
  if (!object(value) || !uuid(value.id) || !uuid(value.requester_id) || !uuid(value.recipient_id) ||
    (expectedId !== undefined && value.id.toLowerCase() !== expectedId.toLowerCase()) ||
    typeof value.status !== 'string' || !['pending', 'accepted', 'declined', 'expired', 'blocked'].includes(value.status) ||
    (value.message !== null && typeof value.message !== 'string') ||
    !resultTimestamp(value.created_at) || (value.responded_at !== null && !resultTimestamp(value.responded_at))) {
    throw new Error('invalid_database_response');
  }
  return {
    id: value.id, requester_id: value.requester_id, recipient_id: value.recipient_id,
    status: value.status, message: value.message, created_at: value.created_at, responded_at: value.responded_at,
  };
}

function matchResult(value: unknown): Payload {
  if (!object(value) || !uuid(value.userId) || typeof value.score !== 'number' ||
    !Number.isFinite(value.score) || value.score < 0 || value.score > 100 ||
    !Array.isArray(value.reasons) || value.reasons.some(reason => typeof reason !== 'string')) {
    throw new Error('invalid_database_response');
  }
  return { userId: value.userId, score: value.score, reasons: [...value.reasons] };
}

function resultResponse(data: unknown, expected: string, route: EntraideRoute, expectedId?: string): Response {
  if (!object(data)) throw new Error('invalid_database_response');
  if ('error' in data) {
    if (typeof data.error !== 'string' || !/^[a-z_]{1,80}$/.test(data.error) ||
      typeof data.status !== 'number' || ![400, 403, 404, 409, 410, 429].includes(data.status)) throw new Error('invalid_database_response');
    return respond(route, { error: data.error }, data.status);
  }
  const value = data[expected];
  if (expected === 'mission') {
    if ('replayed' in data && typeof data.replayed !== 'boolean') throw new Error('invalid_database_response');
    return respond(route, { mission: missionResult(value, expectedId),
      ...('replayed' in data ? { replayed: data.replayed } : {}) });
  }
  if (expected === 'request') return respond(route, { request: contactResult(value, expectedId) });
  if (expected === 'ok' && value === true) return respond(route, { ok: true });
  if (!Array.isArray(value)) throw new Error('invalid_database_response');
  if (expected === 'missions') return respond(route, { missions: value.map(item => missionResult(item)) });
  if (expected === 'requests') {
    if (!Array.isArray(data.blocked_user_ids) || data.blocked_user_ids.some(id => !uuid(id))) throw new Error('invalid_database_response');
    return respond(route, { requests: value.map(item => contactResult(item)), blocked_user_ids: [...data.blocked_user_ids] });
  }
  if (expected === 'matches') {
    const result: Payload = { matches: value.map(item => matchResult(item)) };
    if ('scanned_profiles' in data) {
      if (!integer(data.scanned_profiles, 0, Number.MAX_SAFE_INTEGER)) throw new Error('invalid_database_response');
      result.scanned_profiles = data.scanned_profiles;
    }
    if ('truncated' in data) {
      if (typeof data.truncated !== 'boolean') throw new Error('invalid_database_response');
      result.truncated = data.truncated;
    }
    return respond(route, result);
  }
  throw new Error('invalid_database_response');
}

function respond(route: EntraideRoute, data: unknown, status = 200): Response {
  // The existing helper's second parameter is a number, not a ResponseInit object.
  const response = json(data, status);
  response.headers.set('Access-Control-Allow-Methods', route === 'entraide-profil' ? 'GET, PUT, OPTIONS' :
    route === 'entraide-matches' ? 'GET, OPTIONS' : 'GET, POST, OPTIONS');
  response.headers.set('Access-Control-Expose-Headers', 'Retry-After');
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  if (status === 405) response.headers.set('Allow', response.headers.get('Access-Control-Allow-Methods')!);
  return response;
}

/** Auth is verified before every read/write; the actor never comes from a request body. */
export function createEntraideHandler(route: EntraideRoute, ports: EntraidePorts) {
  return async (req: Request): Promise<Response> => {
    try {
      const path = new URL(req.url).pathname;
      const match = path.match(new RegExp(`^/(?:functions/v1/)?${route}(?:/(.*?))?/?$`));
      if (!match) return respond(route, { error: 'not_found' }, 404);
      const parts = match[1] ? match[1].split('/') : [];
      if (req.method === 'OPTIONS') {
        const preflight = respond(route, null, 200);
        return new Response(null, { status: 204, headers: preflight.headers });
      }
      const allowed = route === 'entraide-profil' ? ['GET', 'PUT'] : route === 'entraide-matches' ? ['GET'] : ['GET', 'POST'];
      if (!allowed.includes(req.method)) return respond(route, { error: 'method_not_allowed' }, 405);
      const header = req.headers.get('Authorization');
      if (!header || !/^Bearer\s+\S+$/i.test(header)) return respond(route, { error: 'authentication_required' }, 401);
      const user = await ports.authenticate(header);
      if (!user || !uuid(user.id)) return respond(route, { error: 'authentication_required' }, 401);
      // Worker-local burst protection. Global contact quotas are enforced transactionally by PostgreSQL.
      const limit = req.method === 'GET' ? 60 : route === 'entraide-profil' ? 20 : 30;
      if (!rateLimit(`${route}:${req.method}:${user.id}`, limit, 60_000).allowed) {
        const response = respond(route, { error: 'rate_limited' }, 429);
        response.headers.set('Retry-After', '60');
        return response;
      }
      if (route === 'entraide-profil') {
        if (parts.length) return respond(route, { error: 'not_found' }, 404);
        if (req.method === 'GET') return respond(route, { profil: await ports.getProfile(user.id) });
        await ports.saveProfile(user.id, profilePayload(await readBody(req)));
        return respond(route, { ok: true });
      }
      if (route === 'entraide-matches') {
        if (parts.length) return respond(route, { error: 'not_found' }, 404);
        return resultResponse(await ports.getMatches(user.id), 'matches', route);
      }
      const kind = route === 'entraide-contact' ? 'contact' : 'mission';
      let action: string; let payload: Payload = {}; let expected: string; let legacyCreation = false;
      if (req.method === 'GET') {
        if (parts.length === 0) { action = 'list'; expected = kind === 'contact' ? 'requests' : 'missions'; }
        else if (kind === 'mission' && parts.length === 1 && uuid(parts[0])) {
          action = 'get'; payload = { mission_id: parts[0] }; expected = 'mission';
        } else return respond(route, { error: 'not_found' }, 404);
      } else if (kind === 'contact') {
        if (parts.length === 0) { action = 'send'; expected = 'request'; }
        else if (parts.length === 1 && ['block', 'unblock'].includes(parts[0])) { action = parts[0]; expected = 'ok'; }
        else if (parts.length === 2 && uuid(parts[0]) && parts[1] === 'respond') {
          action = 'respond'; payload.request_id = parts[0]; expected = 'request';
        } else return respond(route, { error: 'not_found' }, 404);
        payload = { ...contactPayload(await readBody(req), action), ...payload };
      } else {
        if (parts.length === 0) { action = 'create'; expected = 'mission'; }
        else if (parts.length === 2 && uuid(parts[0]) && ['join', 'leave', 'start', 'complete', 'cancel', 'publish', 'unpublish'].includes(parts[1])) {
          action = parts[1]; payload.mission_id = parts[0]; expected = 'mission';
        } else return respond(route, { error: 'not_found' }, 404);
        const input = await readBody(req);
        // #17 assigned the mission UUID server-side. Its migrated durable
        // receipt may therefore map request_id to a different mission UUID.
        legacyCreation = action === 'create' && !('id' in input) && 'request_id' in input;
        payload = { ...missionPayload(input, action), ...payload };
      }
      const expectedId = expected === 'mission' ? payload.mission_id ?? payload.id :
        expected === 'request' ? payload.request_id ?? payload.id : undefined;
      const result = await ports.command(kind, user.id, action, payload);
      if (legacyCreation && object(result) && !('error' in result) &&
        (!object(result.mission) || result.mission.organizer_id !== user.id)) throw new Error('invalid_database_response');
      return resultResponse(result, expected, route,
        !legacyCreation && typeof expectedId === 'string' ? expectedId : undefined);
    } catch (error) {
      if (error instanceof RequestError) return respond(route, { error: error.message }, error.status);
      // Never reflect database errors, credentials or private records in HTTP output or logs.
      return respond(route, { error: 'service_unavailable' }, 503);
    }
  };
}
