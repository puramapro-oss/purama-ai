const assert = require('node:assert/strict');
const { test } = require('node:test');
const { RESOURCE, TIME, uuid, message, snapshot, tick, deferred, fixture, remote, page } = require('./helpers/smarana.cjs');

const completion = (text = 'Réponse réelle du double de test', extra = {}) => ({
  text, modelVersion: 'explicit-test-double', finishReason: 'stop', contextTruncated: false, omittedMessages: 0, tokensGenerated: 8, ...extra,
});
async function controller(t, options = {}) {
  const f = await fixture(t);
  const engine = options.engine ?? { complete: async () => completion(), cancel() {} };
  const { createIaoConversation } = f.load('lib/iao-conversation.ts');
  const conversation = createIaoConversation({ store: f.store, engine, uuid, now: () => TIME });
  t.after(() => conversation.invalidate());
  return { ...f, engine, conversation };
}

test('controller persists the user turn before the mocked engine and reopens the completed transcript', async t => {
  const f = await controller(t);
  const seen = [];
  f.engine.complete = async messages => {
    const row = (await f.store.list())[0];
    seen.push(messages);
    assert.equal(row.payload.messages[0].content, 'Ma demande');
    assert.equal(row.payload.messages[1].state, 'pending');
    assert.equal(row.payload.draft, '');
    return completion('Réponse sauvegardée');
  };
  await f.conversation.open();
  f.conversation.setDraft('Ma demande');
  await f.conversation.send();
  const record = f.conversation.getState().record;
  assert.equal(seen.length, 1);
  assert.equal(record.payload.messages[1].state, 'complete');
  assert.equal(record.payload.messages[1].content, 'Réponse sauvegardée');
  await f.conversation.close();
  await f.store.close();
  const { store } = await f.openStore();
  assert.equal((await store.read(record.resourceId)).payload.messages[1].content, 'Réponse sauvegardée');
});

test('stream checkpoint and cancellation preserve partial text without inventing completion', async t => {
  const started = deferred();
  let token;
  let cancels = 0;
  const f = await controller(t, { engine: {
    complete(_messages, options) {
      token = options.onToken;
      started.resolve();
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Interrompu')), { once: true }));
    },
    cancel() { cancels++; },
  } });
  f.conversation.setDraft('Une réponse longue');
  const sending = f.conversation.send();
  await started.promise;
  token('Début enregistré');
  await f.clock.advance(800);
  const resourceId = f.conversation.getState().record.resourceId;
  assert.equal((await f.store.read(resourceId)).payload.messages[1].content, 'Début enregistré');
  assert.equal((await f.store.read(resourceId)).payload.messages[1].state, 'pending');
  f.conversation.stop();
  token('Token tardif interdit');
  await sending;
  const result = await f.store.read(resourceId);
  assert.equal(result.payload.messages[1].content, 'Début enregistré');
  assert.equal(result.payload.messages[1].state, 'interrupted');
  assert.equal(f.conversation.getState().busy, false);
  assert.equal(f.conversation.getState().liveText, '');
  assert.equal(cancels, 0, 'the per-completion abort signal owns cancellation, never the engine singleton');
});

test('opening another conversation fences new keyboard edits during the transition', async t => {
  const f = await controller(t);
  const a = await f.store.create(snapshot('A', { draft: 'Brouillon A' }), RESOURCE);
  const b = await f.store.create(snapshot('B'), uuid());
  await f.conversation.open(a.resourceId);
  const entered = deferred();
  const release = deferred();
  f.db.before = async (kind, sql) => { if (kind === 'all' && sql.includes('FROM smarana_conversations')) {
    entered.resolve(); await release.promise;
  } };
  const opening = f.conversation.open(b.resourceId);
  await entered.promise;
  const wasTransitioning = f.conversation.getState().transitioning;
  f.conversation.setDraft('Saisie qui ne peut pas être acceptée sur A puis effacée');
  const draftDuringTransition = f.conversation.getState().draft;
  release.resolve();
  await opening;
  assert.equal(wasTransitioning, true);
  assert.equal(draftDuringTransition, 'Brouillon A');
  assert.equal(f.conversation.getState().record.resourceId, b.resourceId);
  assert.equal(f.conversation.getState().transitioning, false);
  assert.equal((await f.store.read(a.resourceId)).payload.draft, 'Brouillon A');
});

test('a failed closing save rejects and keeps the draft available for retry', async t => {
  const f = await controller(t);
  await f.store.create(snapshot(), RESOURCE);
  await f.conversation.open(RESOURCE);
  f.conversation.setDraft('Ne pas abandonner ce brouillon');
  const update = f.store.update.bind(f.store);
  f.store.update = async () => { throw new Error('Disque indisponible'); };
  await assert.rejects(f.conversation.close(), /Disque indisponible/);
  assert.equal(f.conversation.getState().draft, 'Ne pas abandonner ce brouillon');
  assert.equal(f.conversation.getState().dirty, true);
  f.store.update = update;
  await f.conversation.flush();
  assert.equal((await f.store.read(RESOURCE)).payload.draft, 'Ne pas abandonner ce brouillon');
  await f.conversation.close();
});

test('long durable history is bounded before calling the engine without deleting older turns', async t => {
  const f = await controller(t);
  const messages = Array.from({ length: 70 }, (_, i) => [message('user', `Question ${i}`), message('assistant', `Réponse ${i}`)]).flat();
  await f.store.create(snapshot('', { messages }), RESOURCE);
  await f.conversation.open(RESOURCE);
  let seen;
  f.engine.complete = async input => {
    seen = input;
    assert.ok(input.length <= 128, 'native engine message limit');
    assert.equal(input.at(-1).content, 'Question actuelle');
    return completion();
  };
  f.conversation.setDraft('Question actuelle');
  await f.conversation.send();
  assert.ok(seen.length <= 128);
  assert.equal(f.conversation.getState().error, null);
  assert.equal(f.conversation.getState().contextTruncated, true);
  assert.equal((await f.store.read(RESOURCE)).payload.messages.length, 142);
});

test('continuing an interrupted response can use its durable partial content', async t => {
  const f = await controller(t);
  await f.store.create(snapshot('', { messages: [message('user', 'Rédige'), message('assistant', 'Partie déjà vue', 'interrupted')] }), RESOURCE);
  await f.conversation.open(RESOURCE);
  let seen;
  f.engine.complete = async input => { seen = input; return completion('Suite'); };
  f.conversation.setDraft('Continue');
  await f.conversation.send();
  assert.ok(seen.some(item => item.role === 'assistant' && item.content.includes('Partie déjà vue')));
  assert.equal((await f.store.read(RESOURCE)).payload.messages[1].state, 'interrupted');
});

test('a request above the engine bound retains its draft before creating any turn', async t => {
  let calls = 0;
  const f = await controller(t, { engine: { complete: async () => { calls++; return completion(); }, cancel() {} } });
  const text = 'a'.repeat(32_001);
  f.conversation.setDraft(text);
  await f.conversation.send();
  assert.equal(calls, 0);
  assert.equal(f.conversation.getState().draft, text);
  assert.equal(f.conversation.getState().busy, false);
  assert.ok(f.conversation.getState().error);
});

test('a late native completion after invalidation cannot publish or mark a message complete', async t => {
  const started = deferred();
  const finished = deferred();
  let token;
  const f = await controller(t, { engine: { complete(_messages, options) { token = options.onToken; started.resolve(); return finished.promise; }, cancel() {} } });
  f.conversation.setDraft('Demande du compte A');
  const sending = f.conversation.send();
  await started.promise;
  const resourceId = f.conversation.getState().record.resourceId;
  f.conversation.invalidate();
  token('Réponse privée tardive');
  finished.resolve(completion('Résultat tardif'));
  await sending;
  assert.notEqual((await f.store.read(resourceId)).payload.messages[1].state, 'complete');
  assert.equal(f.conversation.getState().record, null);
  assert.equal(f.conversation.getState().draft, '');
});

test('a dirty draft and incoming conflict can be preserved by explicit keep-both', async t => {
  const f = await controller(t);
  await f.store.create(snapshot('Version locale'), RESOURCE);
  await f.conversation.open(RESOURCE);
  f.conversation.setDraft('Dernière saisie avant le conflit');
  await f.store.ingestPull(page(remote(snapshot('Version distante'))), '0');
  await f.conversation.refresh();
  assert.equal(f.conversation.getState().dirty, true);
  await f.conversation.resolveConflict('keep-both');
  const chosen = f.conversation.getState().record;
  assert.notEqual(chosen.resourceId, RESOURCE);
  assert.equal(chosen.payload.draft, 'Dernière saisie avant le conflit');
  assert.equal((await f.store.read(RESOURCE)).payload.messages[0].content, 'Version distante');
});

test('close refuses to abandon a visible response whose terminal write failed and retries it later', async t => {
  const f = await controller(t);
  f.engine.complete = async (_input, options) => {
    options.onToken('Préfixe visible');
    f.db.before = async (_kind, sql) => { if (sql.startsWith('UPDATE smarana_conversations')) throw new Error('Disque plein'); };
    return completion('Réponse finale complète à préserver');
  };
  f.conversation.setDraft('Générer');
  await f.conversation.send();
  const resourceId = f.conversation.getState().record.resourceId;
  assert.equal(f.conversation.getState().busy, false);
  assert.equal(f.conversation.getState().liveText, 'Réponse finale complète à préserver');
  await assert.rejects(f.conversation.close(), /Disque plein/);
  assert.equal(f.conversation.getState().liveText, 'Réponse finale complète à préserver');
  assert.equal(f.conversation.getState().transitioning, false);
  f.db.before = null;
  await f.conversation.close();
  const saved = await f.store.read(resourceId);
  assert.equal(saved.payload.messages[1].content, 'Réponse finale complète à préserver');
  assert.equal(saved.payload.messages[1].state, 'interrupted');
});

test('a stale draft CAS preserves the keyboard input and can retry on the current record', async t => {
  const f = await controller(t);
  const original = await f.store.create(snapshot('Historique'), RESOURCE);
  await f.conversation.open(RESOURCE);
  f.conversation.setDraft('Saisie locale conservée');
  await f.store.update(RESOURCE, original.localVersion, snapshot('Modification concurrente'));
  await assert.rejects(f.conversation.flush(), error => error.code === 'local_conflict');
  assert.equal(f.conversation.getState().draft, 'Saisie locale conservée');
  assert.equal(f.conversation.getState().dirty, true);
  await tick();
  await f.conversation.flush();
  const saved = await f.store.read(RESOURCE);
  assert.equal(saved.payload.messages[0].content, 'Modification concurrente');
  assert.equal(saved.payload.draft, 'Saisie locale conservée');
});

test('a remote deletion cannot consume a keyboard draft or resurrect the deleted identity', async t => {
  const f = await controller(t);
  await f.store.ingestPull(page(remote(snapshot('Ancien historique'))), '0');
  await f.conversation.open(RESOURCE);
  f.conversation.setDraft('Nouvelle idée encore non envoyée');
  await f.store.ingestPull(page(remote(null, { revision: 2, cursor: '2', tombstone: true })), '1');
  await f.conversation.refresh();
  await f.conversation.flush();
  const current = f.conversation.getState().record;
  assert.notEqual(current.resourceId, RESOURCE);
  assert.equal(current.payload.draft, 'Nouvelle idée encore non envoyée');
  assert.deepEqual(current.payload.messages, []);
  assert.equal((await f.store.read(RESOURCE)).tombstone, true);
});

test('history exposes more than 100 conversations through metadata pages and retains the loaded range on refresh', async t => {
  const f = await controller(t);
  for (let i = 0; i < 125; i++) await f.store.create(snapshot('Corps privé '.repeat(1000), { title: `Conversation ${i}` }));
  const historyQueries = [];
  const contentQueries = [];
  f.db.before = async (kind, sql) => {
    if (kind === 'all' && sql.includes('FROM smarana_conversations')) historyQueries.push(sql);
    if (kind === 'first' && sql.includes('SELECT * FROM smarana_conversations')) contentQueries.push(sql);
  };
  await f.conversation.open();
  const selected = f.conversation.getState().record.resourceId;
  assert.equal(f.conversation.getState().conversations.length, 50);
  assert.equal(f.conversation.getState().hasMoreHistory, true);
  assert.equal(contentQueries.length, 1, 'only the selected full transcript is read');
  await f.conversation.loadMoreHistory();
  assert.equal(f.conversation.getState().conversations.length, 100);
  await f.conversation.loadMoreHistory();
  assert.equal(f.conversation.getState().conversations.length, 125);
  assert.equal(f.conversation.getState().hasMoreHistory, false);
  assert.equal(new Set(f.conversation.getState().conversations.map(item => item.resourceId)).size, 125);
  assert.ok(f.conversation.getState().conversations.every(item => typeof item.title === 'string' && !Object.hasOwn(item, 'payload')));
  assert.ok(historyQueries.every(sql => !/\bpayload\b|\bjson_extract\b|SELECT\s+\*/i.test(sql)));
  const removedId = f.conversation.getState().conversations[75].resourceId;
  const removed = await f.store.read(removedId);
  await f.store.tombstone(removedId, removed.localVersion);
  await f.conversation.refresh();
  assert.equal(f.conversation.getState().conversations.length, 124);
  assert.ok(!f.conversation.getState().conversations.some(item => item.resourceId === removedId));
  assert.equal(f.conversation.getState().record.resourceId, selected);
  assert.equal(f.conversation.getState().hasMoreHistory, false);
});
