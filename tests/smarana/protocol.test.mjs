import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SMARANA_LIMITS, SmaranaProtocolError, compareSmaranaCursors, isSmaranaCursor,
  parseSmaranaSnapshot, parseSmaranaMutation, parseSmaranaRecord, parseSmaranaApplyResult, parseSmaranaPullResult,
} from '../../shared/smarana.ts';

const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const resource = '00000000-0000-4000-8000-000000000011';
const mutationId = '00000000-0000-4000-8000-000000000021';
const stamp = '2026-11-23T10:20:30.123Z';
const message = (overrides = {}) => ({ id: '00000000-0000-4000-8000-000000000031', role: 'user', content: 'Échange 🧠 hors ligne', state: 'complete', createdAt: stamp, ...overrides });
const snapshot = (overrides = {}) => ({ title: 'Conversation', messages: [message()], draft: '', ...overrides });
const mutation = (overrides = {}) => ({ schemaVersion: 1, ownerId: owner, resourceId: resource, mutationId, baseRevision: 0, tombstone: false, payload: snapshot(), ...overrides });
const record = (overrides = {}) => ({ schemaVersion: 1, ownerId: owner, resourceId: resource, revision: 1, cursor: '1', tombstone: false, payload: snapshot(), updatedAt: stamp, ...overrides });
const ack = (overrides = {}) => ({ status: 'applied', ownerId: owner, resourceId: resource, mutationId, baseRevision: 0, revision: 1, cursor: '1', updatedAt: stamp, replayed: false, ...overrides });

test('normalizes an omitted draft and snapshots data without sharing mutable arrays', () => {
  const original = { title: 'Mémoire', messages: [message()] };
  const parsed = parseSmaranaSnapshot(original);
  assert.equal(parsed.draft, '');
  original.messages[0].content = 'Changed later';
  assert.equal(parsed.messages[0].content, 'Échange 🧠 hors ligne');
  assert.notEqual(parsed.messages, original.messages);
});

test('counts Unicode points for titles and UTF-8 bytes for message and draft limits', () => {
  parseSmaranaSnapshot(snapshot({ title: '🧠'.repeat(256) }));
  assert.throws(() => parseSmaranaSnapshot(snapshot({ title: '🧠'.repeat(257) })), SmaranaProtocolError);
  const exact = '🧠'.repeat(SMARANA_LIMITS.maxContentBytes / 4);
  parseSmaranaSnapshot(snapshot({ messages: [message({ content: exact })], draft: exact }));
  assert.throws(() => parseSmaranaSnapshot(snapshot({ messages: [message({ content: exact + 'x' })] })), SmaranaProtocolError);
  assert.throws(() => parseSmaranaSnapshot(snapshot({ draft: exact + 'x' })), SmaranaProtocolError);
});

test('bounds the total retained text and message count', () => {
  const full = 'x'.repeat(SMARANA_LIMITS.maxContentBytes);
  const messages = Array.from({ length: 4 }, (_, index) => message({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, content: full }));
  parseSmaranaSnapshot(snapshot({ title: '', messages }));
  assert.throws(() => parseSmaranaSnapshot(snapshot({ messages })), SmaranaProtocolError);
  assert.throws(() => parseSmaranaSnapshot(snapshot({ messages: Array.from({ length: 513 }, () => message()) })), SmaranaProtocolError);
});

test('rejects duplicate IDs, wrong states, invalid dates and non-JSON strings', () => {
  const badMessages = [
    [message(), message()], [message({ role: 'system' })], [message({ state: 'pending' })],
    [message({ content: '' })], [message({ content: '\u0000' })], [message({ content: '\ud800' })],
    [message({ content: '\udfff' })], [message({ createdAt: '2026-02-30T10:20:30.123Z' })],
    [message({ createdAt: '2026-11-23T10:20:30+00:00' })], [message({ createdAt: '0000-01-01T00:00:00.000Z' })],
  ];
  for (const messages of badMessages) assert.throws(() => parseSmaranaSnapshot(snapshot({ messages })), SmaranaProtocolError);
  parseSmaranaSnapshot(snapshot({ messages: [message({ role: 'assistant', content: '', state: 'pending' })] }));
  parseSmaranaSnapshot(snapshot({ messages: [message({ role: 'assistant', content: 'Début conservé', state: 'interrupted' })] }));
});

test('does not run getters, toJSON, custom iterators or accept inherited fields', () => {
  let touched = false;
  const value = { title: 'x', draft: '', get messages() { touched = true; return []; } };
  assert.throws(() => parseSmaranaSnapshot(value), SmaranaProtocolError);
  assert.equal(touched, false);
  assert.throws(() => parseSmaranaSnapshot({ ...snapshot(), toJSON() { touched = true; } }), SmaranaProtocolError);
  const messages = [message()];
  messages[Symbol.iterator] = () => { touched = true; return [][Symbol.iterator](); };
  assert.throws(() => parseSmaranaSnapshot(snapshot({ messages })), SmaranaProtocolError);
  assert.throws(() => parseSmaranaSnapshot(Object.create(snapshot())), SmaranaProtocolError);
  assert.equal(touched, false);
});

test('requires canonical IDs, complete envelopes and safe integer revisions', () => {
  parseSmaranaMutation(mutation());
  for (const change of [{ ownerId: 'A0000000-0000-4000-8000-000000000001' }, { schemaVersion: 2 },
    { baseRevision: -1 }, { baseRevision: 0.5 }, { baseRevision: Number.MAX_SAFE_INTEGER },
    { payload: null }, { tombstone: true }, { unintended: true }]) {
    assert.throws(() => parseSmaranaMutation(mutation(change)), SmaranaProtocolError);
  }
  assert.deepEqual(parseSmaranaMutation(mutation({ tombstone: true, payload: null })).payload, null);
  assert.throws(() => parseSmaranaRecord(record({ revision: 0 })), SmaranaProtocolError);
});

test('keeps large cursors exact without JavaScript numeric coercion', () => {
  assert.equal(isSmaranaCursor('9223372036854775807'), true);
  for (const value of ['00', '-1', '1.0', '1e3', '9223372036854775808', 1]) assert.equal(isSmaranaCursor(value), false);
  assert.equal(compareSmaranaCursors('9007199254740992', '9007199254740993'), -1);
  assert.equal(compareSmaranaCursors('10', '9'), 1);
  assert.throws(() => compareSmaranaCursors('01', '1'), SmaranaProtocolError);
});

test('rejects malformed receipts and foreign conflict snapshots', () => {
  assert.deepEqual(parseSmaranaApplyResult(ack()), ack());
  for (const change of [{ revision: 2 }, { cursor: '0' }, { baseRevision: 0.5 }, { replayed: 'true' }, { current: null }]) {
    assert.throws(() => parseSmaranaApplyResult(ack(change)), SmaranaProtocolError);
  }
  const conflict = { status: 'conflict', ownerId: owner, resourceId: resource, mutationId, baseRevision: 0, replayed: false, reason: 'revision', current: record() };
  parseSmaranaApplyResult(conflict);
  assert.throws(() => parseSmaranaApplyResult({ ...conflict, current: record({ ownerId: other }) }), SmaranaProtocolError);
  assert.throws(() => parseSmaranaApplyResult({ ...conflict, reason: 'deleted' }), SmaranaProtocolError);
});

test('requires ordered, owner-private pull pages and an exact last-record cursor', () => {
  const page = { ownerId: owner, records: [record()], cursor: '1', hasMore: false };
  assert.deepEqual(parseSmaranaPullResult(page), page);
  for (const change of [{ ownerId: other }, { cursor: '2' }, { records: [], hasMore: true },
    { records: [record(), record()] }, { records: [record({ cursor: '2' }), record({ resourceId: mutationId, cursor: '1' })] }]) {
    assert.throws(() => parseSmaranaPullResult({ ...page, ...change }), SmaranaProtocolError);
  }
});
