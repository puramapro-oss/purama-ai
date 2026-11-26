import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Run from karta/ with: node --import tsx ../qa/resolution-qualification-20261125/private-resolution-roundtrip.mjs
// Real tool, projector, migrations, owner reader and chat formatter; disposable
// PGlite only. No application database, model provider, external service or user data.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const receiptPath = resolve(here, 'private-resolution-roundtrip.json');
const kartaRequire = createRequire(resolve(root, 'karta/package.json'));
const { PGlite } = kartaRequire('@electric-sql/pglite');
const migrations = ['001_karta_core.sql', '005_karta_pending_actions.sql', '028_private_tool_results.sql',
  '029_model_usage_receipts.sql', '033_programmatic_model_usage.sql', '034_programmatic_private_reports.sql'];
const resolutionMigrations = (await readdir(resolve(root, 'karta/migrations')))
  .filter(name => /^036_.*resolution.*\.sql$/.test(name));
assert.equal(resolutionMigrations.length, 1, 'Exactly one additive resolution-results migration must be present');
migrations.push(resolutionMigrations[0]);
const sourceFiles = ['karta/src/lib/resolution-qualification.ts', 'karta/src/tools/resolution-qualification.ts',
  'karta/src/engine/private-tool-results.ts', 'karta/src/engine/resolution-result-projection.ts', 'karta/src/knowledge/private-result-view.ts',
  'supabase/functions/_shared/private-tool-results.ts', ...migrations.map(name => `karta/migrations/${name}`)];
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async path =>
  [path, createHash('sha256').update(await readFile(resolve(root, path))).digest('hex')])));
const sourceSha256 = await hashes();
const receipt = { status: 'RUNNING', startedAt: new Date().toISOString(), sourceSha256, checks: [], networkAttempts: 0,
  environment: 'Disposable in-process PostgreSQL PGlite; synthetic identities and dossier',
  limits: ['No provider or production database', 'No browser rendering in this script', 'No external fact, mandate or field-service verification'] };
const check = async (name, fn) => { await fn(); receipt.checks.push({ name, status: 'PASS' }); };
// The projector uses inert null-prototype snapshots; SQL carries their JSON value.
const wireValue = value => JSON.parse(JSON.stringify(value));
const OWNER = '00000000-0000-4000-8000-000000000621';
const OTHER = '00000000-0000-4000-8000-000000000622';
const AGENT = '00000000-0000-4000-8000-000000000623';
const SECOND_AGENT = '00000000-0000-4000-8000-000000000624';
const RUN = randomUUID();
const AGENT_TYPE = `custom:${AGENT}`;
const caseId = 'dossier-synthetique-🌍';
const asOf = '2026-11-25T12:00:00Z';
const observedAt = '2026-11-25T09:00:00Z';
const reference = (id, subjectId, kind, text = `Pièce déclarée ${id}`) => ({
  id, caseId, snapshotRevision: 4, subjectId, kind, reference: text, observedAt,
});
const input = {
  caseId, snapshotRevision: 4, asOf, domains: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'],
  sources: [
    reference('src-a', 'exigence-a', 'requirement'), reference('src-b', 'exigence-b', 'requirement'),
    reference('src-alternative', 'alternative-a', 'alternative'), reference('src-acceptation', 'alternative-a', 'acceptance'),
    reference('src-periode', 'periode-active', 'activation'), reference('src-correction', 'correction-adresse', 'correction'),
    reference('src-envoi', 'relais-a', 'transmission', 'Pièce fournie <script>instruction non fiable</script> & 🌍'),
    reference('src-mandat', 'relais-a', 'authorization'),
    { ...reference('src-autre-dossier', 'relais-a', 'performance'), caseId: 'autre-dossier' },
  ],
  dependencies: [
    { id: 'exigence-a', state: 'unknown', basis: 'attested_rule', requires: ['exigence-b'], sourceIds: ['src-a'], satisfactionSourceIds: [],
      alternatives: [{ id: 'alternative-a', prerequisiteId: 'exigence-b', state: 'reported_accepted', sourceIds: ['src-alternative'], acceptanceSourceIds: ['src-acceptation'] }] },
    { id: 'exigence-b', state: 'unknown', basis: 'interlocutor_request', requires: ['exigence-a'], sourceIds: ['src-b'], satisfactionSourceIds: [], alternatives: [] },
  ],
  transitions: [{ id: 'changement-aidant', timeZone: 'Europe/Paris', windowStart: '2026-11-25T08:00:00Z', windowEnd: '2026-11-25T12:00:00Z',
    periods: [{ id: 'periode-active', start: '2026-11-25T09:00:00Z', end: '2026-11-25T11:00:00Z', stage: 'reported_active', sourceIds: ['src-periode'] },
      { id: 'periode-inconnue', stage: 'agreed', sourceIds: [] }] }],
  effort: { chosenMinutes: 2, paused: false, maxCalls: 0, maxTrips: 0, steps: [
    { id: 'piece-deja-fournie', state: 'completed', estimatedMinutes: 1, calls: 0, trips: 0 },
    { id: 'prochaine-action-courte', state: 'pending', estimatedMinutes: 2, calls: 0, trips: 0 },
    { id: 'deplacement-long', state: 'pending', estimatedMinutes: 25, calls: 1, trips: 1 },
  ] },
  corrections: [{ id: 'correction-adresse', factId: 'adresse', fromVersion: 1, toVersion: 2, expectedVersion: 1, currentVersion: 1,
    assertion: 'reported_established', sourceIds: ['src-correction'], consequences: [
      { id: 'brouillon', version: 1, dependsOn: ['adresse'], stage: 'draft' },
      { id: 'organisme', version: 1, dependsOn: ['brouillon'], stage: 'transmitted' },
      { id: 'attestation-inconnue', version: 1, dependsOn: ['intermediaire-manquant'], stage: 'transmitted' },
      { id: 'demande-liee', version: 1, dependsOn: ['attestation-inconnue'], stage: 'draft' },
    ] }],
  occurrence: { requested: 'new_episode', current: { episodeId: 'nouvel-episode', beneficiaryId: 'personne', objectId: 'objet', periodId: 'periode',
    engagementId: 'engagement', territory: 'FR', operationId: 'operation-deja-tentee', payloadHash: 'empreinte-declaree' },
    previous: { episodeId: 'episode-precedent', beneficiaryId: 'personne', objectId: 'objet', periodId: 'periode', engagementId: 'engagement',
      territory: 'FR', operationId: 'operation-deja-tentee', payloadHash: 'empreinte-declaree', state: 'closed', effect: 'uncertain', attempts: 2 },
    attemptLimit: 3, revoked: false },
  handoffs: [{ id: 'relais-a', recipientId: 'aidant-declare', recipientState: 'reported_resolved', role: 'aidant', channel: 'canal-fourni',
    actionId: 'recevoir-piece', dataIds: ['piece-a'], requestedStage: 'performed', conflicting: false,
    transmissionSourceIds: ['src-envoi'], acceptanceSourceIds: [], performanceSourceIds: [],
    authorization: { status: 'reported_valid', caseId, actorId: 'aidant-declare', actionIds: ['recevoir-piece'], dataIds: ['piece-a'],
      expiresAt: '2026-11-26T12:00:00Z', sourceIds: ['src-mandat'] } }],
};

// These values prevent an imported server client from selecting application credentials.
process.env.DOTENV_CONFIG_PATH = resolve(here, 'nonexistent-synthetic-environment');
process.env.SUPABASE_URL = 'https://database.fixture.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-test-key-not-a-credential';
process.env.KARTA_MOCK_CLAUDE = 'true';
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { receipt.networkAttempts++; throw new Error('Network disabled in private-resolution reception'); };
let db;
try {
  const { resolutionQualificationTool } = await import(pathToFileURL(resolve(root, 'karta/src/tools/resolution-qualification.ts')).href);
  const { projectPrivateToolResult } = await import(pathToFileURL(resolve(root, 'karta/src/engine/private-tool-results.ts')).href);
  const { parsePrivateToolResult } = await import(pathToFileURL(resolve(root, 'karta/src/knowledge/private-result-view.ts')).href);
  const { loadSelectedPrivateToolResults, formatPrivateToolResultContext, PRIVATE_RESULT_CONTEXT_MAX_BYTES } = await import(
    pathToFileURL(resolve(root, 'supabase/functions/_shared/private-tool-results.ts')).href);
  let qualified, projected, storedRow, parsed;
  await check('real qualifier preserves the six distinct assessments, supplied sources and unknown effects', async () => {
    const before = structuredClone(input);
    qualified = await resolutionQualificationTool.execute(input, { userId: OWNER, agentType: AGENT_TYPE, mode: 'live', operationId: `${RUN}:0` });
    assert.deepEqual(input, before);
    assert.deepEqual(qualified.dependencies.originalCycles, [['exigence-a', 'exigence-b']]);
    assert.deepEqual(qualified.dependencies.remainingCycles, []);
    assert.deepEqual(qualified.dependencies.nextCandidateIds, ['exigence-a']);
    assert.equal(qualified.transitions[0].gaps.length, 2);
    assert.deepEqual(qualified.transitions[0].unknownPeriodIds, ['periode-inconnue']);
    assert.equal(qualified.effort.nextStepId, 'prochaine-action-courte');
    assert.deepEqual(qualified.corrections[0].impactUnknownIds, ['attestation-inconnue', 'demande-liee']);
    assert.equal(qualified.occurrence.assessment, 'reconcile_unknown_effect');
    assert.equal(qualified.handoffs[0].referencedStage, 'transmitted');
    assert.equal(qualified.handoffs[0].stageOrderVerified, false);
    assert.deepEqual(qualified.rejectedSourceIds, ['src-autre-dossier']);
    assert.deepEqual(qualified.suppliedReferences, input.sources);
    input.sources[0].reference = 'temporary caller mutation';
    assert.equal(qualified.suppliedReferences[0].reference, before.sources[0].reference);
    input.sources[0].reference = before.sources[0].reference;
    assert.equal(qualified.externalFactsVerified, false);
    assert.equal(qualified.permissionsGranted, false);
    assert.equal(qualified.externalActionsPerformed, 0);
  });
  await check('real private projection retains every section and supplied reference within its UTF-8 budget', async () => {
    projected = projectPrivateToolResult('qualify_resolution', qualified);
    assert.ok(projected);
    assert.equal(projected.tool_name, 'qualify_resolution');
    assert.deepEqual(projected.sources, []);
    assert.deepEqual(projected.details.snapshot, { caseId, snapshotRevision: 4, asOf });
    assert.deepEqual(projected.details.sections.map(section => section.id), ['dependencies', 'transitions', 'effort', 'corrections', 'occurrence', 'handoffs']);
    assert.equal(projected.details.supplied_references.length, input.sources.length);
    assert.deepEqual(projected.details.rejected_source_ids, ['src-autre-dossier']);
    assert.equal(projected.details.verification_status, 'unverified');
    assert.equal(projected.details.permissions_granted, false);
    assert.equal(projected.details.external_actions_performed, 0);
    assert.ok(Buffer.byteLength(JSON.stringify(projected), 'utf8') <= 61_440);
  });

  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.user_id',true),'')::uuid $$;
    CREATE SCHEMA purama_ai;
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA purama_ai,auth TO anon,authenticated,service_role;
    CREATE TABLE purama_ai.creator_agents (
      id uuid PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
      is_active boolean DEFAULT true, karta_enabled boolean DEFAULT true, tools_enabled text[] DEFAULT '{}'
    );
    ALTER TABLE purama_ai.creator_agents ENABLE ROW LEVEL SECURITY;
    CREATE POLICY owner_read ON purama_ai.creator_agents FOR SELECT TO authenticated USING(user_id = auth.uid());
  `);
  for (const file of migrations) {
    await db.exec(await readFile(resolve(root, 'karta/migrations', file), 'utf8'));
    if (file === '005_karta_pending_actions.sql') {
      await db.exec('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA purama_ai TO service_role; GRANT SELECT ON ALL TABLES IN SCHEMA purama_ai TO authenticated;');
    }
  }
  // Reapplying the additive migration must retain existing data and policies.
  await db.exec(await readFile(resolve(root, 'karta/migrations', resolutionMigrations[0]), 'utf8'));
  await db.query('INSERT INTO auth.users(id) VALUES($1),($2)', [OWNER, OTHER]);
  await db.query("INSERT INTO purama_ai.creator_agents(id,user_id,tools_enabled) VALUES($1,$2,ARRAY['qualify_resolution']),($3,$2,ARRAY['qualify_resolution'])", [AGENT, OWNER, SECOND_AGENT]);
  const role = async (name, user = OWNER) => {
    assert.ok(['authenticated', 'service_role'].includes(name));
    await db.exec(`SET ROLE ${name}`);
    await db.query("SELECT set_config('test.user_id',$1,false)", [user]);
  };
  await role('service_role');
  await db.query("INSERT INTO purama_ai.karta_runs(id,user_id,agent_type,trigger_type,mode,status,duration_ms,claude_mock) VALUES($1,$2,$3,'manual','live','running',NULL,false)", [RUN, OWNER, AGENT_TYPE]);
  const store = async (payload = projected, operationId = `${RUN}:0`, runId = RUN) => (await db.query(
    'SELECT purama_ai.karta_store_tool_result($1,$2,$3,$4,$5,$6::jsonb) AS id',
    [OWNER, AGENT_TYPE, runId, operationId, 'qualify_resolution', JSON.stringify(payload)],
  )).rows[0].id;
  const readRows = async ({ ownerId, agentId, ids, signal }) => {
    signal.throwIfAborted();
    const response = await db.query('SELECT id,run_id,creator_agent_id,user_id,tool_name,payload,created_at::text AS created_at FROM purama_ai.karta_tool_results WHERE user_id=$1 AND creator_agent_id=$2 AND id=ANY($3::uuid[])', [ownerId, agentId, ids]);
    signal.throwIfAborted();
    return { data: response.rows, error: null };
  };
  let savedId;
  await check('real SQL stores once and the owner parser preserves the structured private result', async () => {
    savedId = await store();
    const size = (await db.query('SELECT octet_length(payload::text) AS bytes FROM purama_ai.karta_tool_results WHERE id=$1', [savedId])).rows[0].bytes;
    assert.ok(size <= 65_536);
    receipt.payloadBytes = { compactUtf8: Buffer.byteLength(JSON.stringify(projected), 'utf8'), postgresJsonb: size };
    await role('authenticated', OWNER);
    const response = await readRows({ ownerId: OWNER, agentId: AGENT, ids: [savedId], signal: new AbortController().signal });
    assert.equal(response.data.length, 1);
    storedRow = response.data[0];
    parsed = parsePrivateToolResult(storedRow, OWNER, AGENT);
    assert.ok(parsed);
    assert.equal('details' in parsed.payload, false);
    assert.deepEqual(parsed.payload.resolution.snapshot, { caseId, snapshotRevision: 4, asOf });
    assert.deepEqual(parsed.payload.resolution.sections, wireValue(projected.details.sections));
    assert.deepEqual(parsed.payload.resolution.supplied_references, wireValue(projected.details.supplied_references));
    assert.deepEqual(parsed.payload.resolution.rejected_source_ids, ['src-autre-dossier']);
    receipt.browserFixture = { ownerId: OWNER, agentId: AGENT, storedRow, parsedResult: parsed };
  });
  // Reuse this dossier and the established core scenarios, without reproducing the
  // complete unit-test matrix. Both variants traverse the real SQL reader as well.
  const unresolved = structuredClone(input);
  unresolved.dependencies[0].state = 'conflicting';
  unresolved.dependencies[0].requires.push('prerequis-inconnu');
  unresolved.dependencies[0].alternatives[0].state = 'reported_refused';
  delete unresolved.transitions[0].windowStart;
  delete unresolved.transitions[0].windowEnd;
  unresolved.effort.paused = true;
  unresolved.effort.steps.push({ id: 'duree-inconnue', state: 'pending' });
  unresolved.corrections[0].currentVersion = 3;
  unresolved.occurrence.requested = 'technical_retry';
  unresolved.occurrence.current.episodeId = unresolved.occurrence.previous.episodeId;
  unresolved.handoffs[0].authorization.status = 'revoked';
  unresolved.handoffs[0].recipientState = 'unknown';
  unresolved.handoffs[0].conflicting = true;
  const variants = [
    { name: 'all six absent facets remain unknown after qualification, SQL storage and owner reading',
      input: { caseId, snapshotRevision: 4, asOf, domains: ['A'], sources: [] },
      verify(raw, view) {
        for (const section of view.sections) {
          assert.equal(raw[section.id], null);
          assert.equal(section.availability, 'not_provided');
          assert.deepEqual(section.items, []);
          assert.match(section.summary, /Aucune information fournie/);
        }
      } },
    { name: 'conflicts, unknown windows, pause, uncertain replay and blocked handoff remain consultable', input: unresolved,
      verify(raw, view) {
        assert.equal(raw.transitions[0].gaps, null);
        assert.equal(raw.effort.paused, true); assert.equal(raw.effort.nextStepId, null);
        assert.equal(raw.corrections[0].assessment, 'version_conflict');
        assert.equal(raw.occurrence.assessment, 'reconcile_unknown_effect');
        assert.equal(raw.handoffs[0].futureSharing, 'blocked_pending_qualification');
        assert.ok(raw.handoffs[0].reasons.includes('authorization_revoked'));
        const sectionText = id => { const section = view.sections.find(section => section.id === id); return [section.summary, ...section.items].join('\n'); };
        assert.match(sectionText('dependencies'), /affirmations contradictoires/);
        assert.match(sectionText('dependencies'), /refus déclaré/);
        assert.match(sectionText('dependencies'), /prerequis-inconnu/);
        assert.match(sectionText('transitions'), /inconnu, aucun intervalle calculable/);
        assert.match(sectionText('effort'), /pause demandée/);
        assert.match(sectionText('effort'), /aucune proposée/);
        assert.match(sectionText('effort'), /durée inconnue/);
        assert.match(sectionText('corrections'), /rapprocher les versions/);
        assert.match(sectionText('occurrence'), /effet inconnu à rapprocher/);
        assert.match(sectionText('handoffs'), /partage bloqué/);
        assert.match(sectionText('handoffs'), /autorisation déclarée révoquée/);
      } },
  ];
  receipt.variantCases = [];
  for (const variant of variants) await check(variant.name, async () => {
    const variantRun = randomUUID();
    const raw = await resolutionQualificationTool.execute(variant.input, { userId: OWNER, agentType: AGENT_TYPE, mode: 'live', operationId: `${variantRun}:0` });
    const payload = projectPrivateToolResult('qualify_resolution', raw);
    assert.ok(payload);
    await role('service_role');
    await db.query("INSERT INTO purama_ai.karta_runs(id,user_id,agent_type,trigger_type,mode,status,duration_ms,claude_mock) VALUES($1,$2,$3,'manual','live','running',NULL,false)", [variantRun, OWNER, AGENT_TYPE]);
    const id = await store(payload, `${variantRun}:0`, variantRun);
    await role('authenticated', OWNER);
    const selected = await loadSelectedPrivateToolResults(readRows, OWNER, AGENT, [id], new AbortController().signal);
    const view = selected[0].payload.resolution;
    assert.ok(view);
    variant.verify(raw, view);
    assert.equal(JSON.parse(formatPrivateToolResultContext(selected)).results[0].evidence.verification_status, 'unverified');
    assert.equal((await db.query('DELETE FROM purama_ai.karta_tool_results WHERE id=$1 RETURNING id', [id])).rows.length, 0);
    await role('service_role');
    await db.query("UPDATE purama_ai.karta_runs SET status='success',duration_ms=1,finished_at=now() WHERE id=$1", [variantRun]);
    await role('authenticated', OWNER);
    assert.equal((await db.query('DELETE FROM purama_ai.karta_tool_results WHERE id=$1 RETURNING id', [id])).rows.length, 1);
    receipt.variantCases.push({ name: variant.name, status: 'PASS', sections: view.sections.map(section => ({ id: section.id, availability: section.availability })) });
  });
  await check('another account cannot read the row, even with the original owner ID in its request', async () => {
    await role('authenticated', OTHER);
    assert.equal((await db.query('SELECT id FROM purama_ai.karta_tool_results')).rows.length, 0);
    assert.equal(parsePrivateToolResult(storedRow, OTHER, AGENT), null);
    await assert.rejects(loadSelectedPrivateToolResults(readRows, OWNER, AGENT, [savedId], new AbortController().signal), /indisponibles/);
  });
  await check('another agent of the same owner cannot select this dossier result', async () => {
    await role('authenticated', OWNER);
    assert.equal(parsePrivateToolResult(storedRow, OWNER, SECOND_AGENT), null);
    await assert.rejects(loadSelectedPrivateToolResults(readRows, OWNER, SECOND_AGENT, [savedId], new AbortController().signal), /indisponibles/);
  });
  await check('the real selected-result loader and chat formatter retain snapshot and bounded unverified context', async () => {
    const selected = await loadSelectedPrivateToolResults(readRows, OWNER, AGENT, [savedId], new AbortController().signal);
    const encoded = formatPrivateToolResultContext(selected);
    const context = JSON.parse(encoded);
    assert.equal(context.trust, 'untrusted_data');
    assert.equal(context.results.length, 1);
    const item = context.results[0];
    assert.equal(item.tool_name, 'qualify_resolution');
    assert.equal(item.result_id, savedId);
    assert.equal(item.evidence.verification_status, 'unverified');
    assert.equal(item.evidence.qualification_only, true);
    assert.equal(item.evidence.external_facts_verified, false);
    assert.equal(item.evidence.permissions_granted, false);
    assert.equal(item.evidence.external_actions_performed, 0);
    assert.equal('backend_kind' in item.evidence, false);
    assert.ok(encoded.includes(asOf), 'The supplied snapshot date must not disappear from the model context');
    assert.equal(encoded.includes('<script>'), false);
    assert.ok(Buffer.byteLength(encoded, 'utf8') <= PRIVATE_RESULT_CONTEXT_MAX_BYTES);
    receipt.chatContext = { bytes: Buffer.byteLength(encoded, 'utf8'), value: context };
  });
  await check('identical delivery reconciles to one row while a divergent payload cannot overwrite it', async () => {
    await role('service_role');
    assert.equal(await store(), savedId);
    assert.equal((await db.query('SELECT count(*)::integer AS count FROM purama_ai.karta_tool_results')).rows[0].count, 1);
    await assert.rejects(store({ ...projected, summary: projected.summary + ' Contenu divergent.' }), /Private result unavailable/);
    assert.deepEqual((await db.query('SELECT payload FROM purama_ai.karta_tool_results WHERE id=$1', [savedId])).rows[0].payload, wireValue(projected));
  });
  await check('closure allows owner deletion and prevents replay from recreating the deleted result', async () => {
    await db.query("UPDATE purama_ai.karta_runs SET status='success',duration_ms=1,finished_at=now() WHERE id=$1", [RUN]);
    assert.equal(await store(), savedId);
    await role('authenticated', OWNER);
    assert.deepEqual((await db.query('DELETE FROM purama_ai.karta_tool_results WHERE id=$1 RETURNING id', [savedId])).rows, [{ id: savedId }]);
    await role('service_role');
    await assert.rejects(store(), /Private result unavailable/);
    assert.equal((await db.query('SELECT count(*)::integer AS count FROM purama_ai.karta_tool_results')).rows[0].count, 0);
  });
  await check('no network was used and every exercised source stayed identical during reception', async () => {
    assert.equal(receipt.networkAttempts, 0);
    assert.deepEqual(await hashes(), sourceSha256);
  });
  receipt.status = 'PASS';
} catch (error) {
  receipt.status = 'FAIL';
  receipt.failure = { name: error.name, message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await db?.close();
  globalThis.fetch = originalFetch;
  receipt.finishedAt = new Date().toISOString();
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ status: receipt.status, checks: receipt.checks.length, networkAttempts: receipt.networkAttempts, receipt: receiptPath,
    ...(receipt.failure ? { failure: receipt.failure.message } : {}) }));
}
