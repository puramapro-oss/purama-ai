/** The account-private SMARANA wire contract. No runtime, network or Node dependency. */
export const SMARANA_SCHEMA_VERSION = 1 as const;
export const SMARANA_LIMITS = Object.freeze({
  maxTitleCodePoints: 256,
  maxMessages: 512,
  maxContentBytes: 262_144,
  maxDraftBytes: 262_144,
  maxTotalContentBytes: 1_048_576,
  maxPullRecords: 20,
  maxBaseRevision: Number.MAX_SAFE_INTEGER - 1,
  maxCursor: '9223372036854775807',
});

export type SmaranaMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  state: 'pending' | 'complete' | 'interrupted';
  createdAt: string;
};
export type SmaranaConversationSnapshot = { title: string; messages: SmaranaMessage[]; draft: string };
export type SmaranaMutation = {
  schemaVersion: 1;
  ownerId: string;
  resourceId: string;
  mutationId: string;
  baseRevision: number;
  tombstone: boolean;
  payload: SmaranaConversationSnapshot | null;
};
export type SmaranaRemoteRecord = {
  schemaVersion: 1;
  ownerId: string;
  resourceId: string;
  revision: number;
  cursor: string;
  tombstone: boolean;
  payload: SmaranaConversationSnapshot | null;
  updatedAt: string;
};
type ReceiptIdentity = {
  ownerId: string;
  resourceId: string;
  mutationId: string;
  baseRevision: number;
  replayed: boolean;
};
export type SmaranaApplied = ReceiptIdentity & {
  status: 'applied';
  revision: number;
  cursor: string;
  updatedAt: string;
};
export type SmaranaConflict = ReceiptIdentity & {
  status: 'conflict';
  reason: 'revision' | 'deleted' | 'mutation_reused';
  current: SmaranaRemoteRecord | null;
};
export type SmaranaApplyResult = SmaranaApplied | SmaranaConflict;
export type SmaranaPullResult = {
  ownerId: string;
  records: SmaranaRemoteRecord[];
  cursor: string;
  hasMore: boolean;
};

export class SmaranaProtocolError extends Error {
  constructor() { super('Les données de continuité sont invalides.'); this.name = 'SmaranaProtocolError'; }
}
const invalid = (): never => { throw new SmaranaProtocolError(); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function isSmaranaUuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
export function isSmaranaCursor(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value)
    && (value.length < 19 || value <= SMARANA_LIMITS.maxCursor);
}
export function compareSmaranaCursors(left: string, right: string): number {
  if (!isSmaranaCursor(left) || !isSmaranaCursor(right)) return invalid();
  return left.length === right.length ? (left === right ? 0 : left < right ? -1 : 1) : left.length < right.length ? -1 : 1;
}

/** Snapshot own data properties only; never run a supplied getter or toJSON. */
function object(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key)) || required.some(key => !keys.includes(key))) return invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return invalid();
    result[key as string] = descriptor.value;
  }
  return result;
}
function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value as unknown;
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > limit
    || Reflect.ownKeys(value).length !== length + 1) return invalid();
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) return invalid();
    result.push(descriptor.value);
  }
  return result;
}
function uuid(value: unknown): string { return isSmaranaUuid(value) ? value : invalid(); }
function cursor(value: unknown, positive = false): string {
  return isSmaranaCursor(value) && (!positive || value !== '0') ? value : invalid();
}
function integer(value: unknown, min: number, max: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid();
}
function boolean(value: unknown): boolean { return typeof value === 'boolean' ? value : invalid(); }
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  return typeof value === 'string' && choices.includes(value as T) ? value as T : invalid();
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value)
    || value.startsWith('0000-')) return invalid();
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value ? value : invalid();
}
/** UTF-8 accounting also rejects NUL and unpaired UTF-16 surrogates before JSON transport. */
function text(value: unknown, maxBytes: number, maxPoints = Number.MAX_SAFE_INTEGER): { value: string; bytes: number } {
  if (typeof value !== 'string' || value.length > maxBytes) return invalid();
  let bytes = 0;
  let points = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0 || (code >= 0xdc00 && code <= 0xdfff)) return invalid();
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return invalid();
      bytes += 4;
    } else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (bytes > maxBytes || ++points > maxPoints) return invalid();
  }
  return { value, bytes };
}

export function parseSmaranaMessage(value: unknown): SmaranaMessage {
  const data = object(value, ['id', 'role', 'content', 'state', 'createdAt']);
  const role = choice(data.role, ['user', 'assistant']);
  const state = choice(data.state, ['pending', 'complete', 'interrupted']);
  const content = text(data.content, SMARANA_LIMITS.maxContentBytes).value;
  if ((role === 'user' && state !== 'complete') || (state === 'complete' && !content.length)) return invalid();
  return { id: uuid(data.id), role, content, state, createdAt: timestamp(data.createdAt) };
}
export function parseSmaranaSnapshot(value: unknown): SmaranaConversationSnapshot {
  const data = object(value, ['title', 'messages', 'draft'], ['title', 'messages']);
  const title = text(data.title, SMARANA_LIMITS.maxTotalContentBytes, SMARANA_LIMITS.maxTitleCodePoints);
  const draft = text(data.draft === undefined ? '' : data.draft, SMARANA_LIMITS.maxDraftBytes);
  const messages = array(data.messages, SMARANA_LIMITS.maxMessages).map(parseSmaranaMessage);
  if (new Set(messages.map(message => message.id)).size !== messages.length) return invalid();
  const total = messages.reduce((sum, message) => sum + text(message.content, SMARANA_LIMITS.maxContentBytes).bytes, title.bytes + draft.bytes);
  if (total > SMARANA_LIMITS.maxTotalContentBytes) return invalid();
  return { title: title.value, messages, draft: draft.value };
}
export function parseSmaranaMutation(value: unknown): SmaranaMutation {
  const data = object(value, ['schemaVersion', 'ownerId', 'resourceId', 'mutationId', 'baseRevision', 'tombstone', 'payload']);
  if (data.schemaVersion !== SMARANA_SCHEMA_VERSION) return invalid();
  const tombstone = boolean(data.tombstone);
  if (tombstone && data.payload !== null) return invalid();
  return {
    schemaVersion: 1, ownerId: uuid(data.ownerId), resourceId: uuid(data.resourceId), mutationId: uuid(data.mutationId),
    baseRevision: integer(data.baseRevision, 0, SMARANA_LIMITS.maxBaseRevision), tombstone,
    payload: tombstone ? null : parseSmaranaSnapshot(data.payload),
  };
}
export function parseSmaranaRecord(value: unknown): SmaranaRemoteRecord {
  const data = object(value, ['schemaVersion', 'ownerId', 'resourceId', 'revision', 'cursor', 'tombstone', 'payload', 'updatedAt']);
  if (data.schemaVersion !== SMARANA_SCHEMA_VERSION) return invalid();
  const tombstone = boolean(data.tombstone);
  if (tombstone && data.payload !== null) return invalid();
  return {
    schemaVersion: 1, ownerId: uuid(data.ownerId), resourceId: uuid(data.resourceId),
    revision: integer(data.revision, 1, Number.MAX_SAFE_INTEGER), cursor: cursor(data.cursor, true), tombstone,
    payload: tombstone ? null : parseSmaranaSnapshot(data.payload), updatedAt: timestamp(data.updatedAt),
  };
}
export function parseSmaranaApplyResult(value: unknown): SmaranaApplyResult {
  const keys = ['status', 'ownerId', 'resourceId', 'mutationId', 'baseRevision', 'replayed'];
  const data = object(value, [...keys, 'revision', 'cursor', 'updatedAt', 'reason', 'current'], keys);
  const identity: ReceiptIdentity = {
    ownerId: uuid(data.ownerId), resourceId: uuid(data.resourceId), mutationId: uuid(data.mutationId),
    baseRevision: integer(data.baseRevision, 0, SMARANA_LIMITS.maxBaseRevision), replayed: boolean(data.replayed),
  };
  if (data.status === 'applied') {
    object(value, [...keys, 'revision', 'cursor', 'updatedAt']);
    const revision = integer(data.revision, 1, Number.MAX_SAFE_INTEGER);
    if (revision !== identity.baseRevision + 1) return invalid();
    return { ...identity, status: 'applied', revision, cursor: cursor(data.cursor, true), updatedAt: timestamp(data.updatedAt) };
  }
  if (data.status !== 'conflict') return invalid();
  object(value, [...keys, 'reason', 'current']);
  const reason = choice(data.reason, ['revision', 'deleted', 'mutation_reused']);
  const current = data.current === null ? null : parseSmaranaRecord(data.current);
  if (current && (current.ownerId !== identity.ownerId || current.resourceId !== identity.resourceId)) return invalid();
  if (reason === 'deleted' && !current?.tombstone) return invalid();
  return { ...identity, status: 'conflict', reason, current };
}
export function parseSmaranaPullResult(value: unknown): SmaranaPullResult {
  const data = object(value, ['ownerId', 'records', 'cursor', 'hasMore']);
  const ownerId = uuid(data.ownerId);
  const records = array(data.records, SMARANA_LIMITS.maxPullRecords).map(parseSmaranaRecord);
  const nextCursor = cursor(data.cursor);
  const hasMore = boolean(data.hasMore);
  if (records.some(record => record.ownerId !== ownerId) || new Set(records.map(record => record.resourceId)).size !== records.length
    || records.some((record, index) => index > 0 && compareSmaranaCursors(records[index - 1].cursor, record.cursor) >= 0)
    || (records.length && records[records.length - 1].cursor !== nextCursor) || (!records.length && hasMore)) return invalid();
  return { ownerId, records, cursor: nextCursor, hasMore };
}

// These validators return owned, normalized copies, not a boolean or the caller's mutable objects.
export const validateSnapshot = parseSmaranaSnapshot;
export const validateMutation = parseSmaranaMutation;
export const validateRemoteRecord = parseSmaranaRecord;
