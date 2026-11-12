// Opt-in model observation, outside CI. No business service or cloud inference.
// Node >= 22 with --experimental-strip-types; no additional dependencies.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAssistantSystemPrompt, ASSISTANT_POLICY_VERSION } from '../../karta/src/claude/assistant-policy.ts';

assert.equal(process.env.PURAMA_LOCAL_POLICY_EVAL, '1', 'Explicit opt-in required');
assert.ok(process.argv[2], 'Provide a new JSON evidence file');
const output = resolve(process.argv[2]);
const directory = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(await readFile(join(directory, 'cases.json'), 'utf8'));
const model = 'qwen3-coder:30b';
const expectedDigest = '06c1097efce0431c2045fe7b2e5108366e43bee1b4603a7aded8f21689e90bca';
const origin = 'http://127.0.0.1:11434';
const options = { temperature: 0, seed: 20261112, num_predict: 1024, num_ctx: 8192 };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const policySource = await readFile(new URL('../../karta/src/claude/assistant-policy.ts', import.meta.url));
const report = {
  started_at: new Date().toISOString(), model, expected_digest: expectedDigest,
  policy_version: ASSISTANT_POLICY_VERSION, policy_sha256: sha256(policySource),
  harness_sha256: sha256(await readFile(fileURLToPath(import.meta.url))),
  cases_sha256: sha256(await readFile(join(directory, 'cases.json'))),
  route: `${origin}/api/chat`, options, maximum_rounds_per_case: 4,
  context_truncation_independently_verified: false,
  scope: 'Real local model; canonical policy builder; synthetic data; bounded fixture tools. Not KARTA end-to-end, human review, clinical efficacy, or production.',
  semantic_review: 'PENDING; automated checks only establish explicit structural and fixture conditions',
  cases: [],
};
await mkdir(dirname(output), { recursive: true });
// Fail rather than replacing any prior observations.
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const persist = () => writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });

async function request(path, body) {
  assert.ok(['/api/version', '/api/tags', '/api/show', '/api/chat'].includes(path));
  const response = await fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(120_000),
  });
  assert.equal(response.status, 200, `Local HTTP status ${response.status}`);
  return await response.json();
}

function tool(name, description, properties, required) {
  return { type: 'function', function: { name, description,
    parameters: { type: 'object', additionalProperties: false, properties, required } } };
}
const filename = { type: 'string', enum: ['atelier-dessin.md'] };
const schemas = {
  write_artifact: tool('write_artifact', 'Écrit uniquement le document fictif atelier-dessin.md dans un dossier temporaire de ce test.',
    { filename, content: { type: 'string' } }, ['filename', 'content']),
  read_artifact: tool('read_artifact', 'Relit le document fictif enregistré dans ce test.', { filename }, ['filename']),
  find_missions: tool('find_missions', 'Recherche les dossiers fictifs existants dans ce test.', {}, []),
  update_materials: tool('update_materials', 'Complète la liste de matériel de la mission fictive identifiée.',
    { mission_id: { type: 'string' }, materials: { type: 'array', items: { type: 'string' } } }, ['mission_id', 'materials']),
  export_pdf: tool('export_pdf', 'Demande un export PDF fictif. La réponse confirme seulement son état actuel.', {}, []),
  get_export_status: tool('get_export_status', 'Lit l’état actuel de l’export fictif.',
    { job_id: { type: 'string', enum: ['export-001'] } }, ['job_id']),
};

function exposedTools(fixture) {
  const names = {
    artifact: ['write_artifact', 'read_artifact'],
    mission: ['find_missions', 'update_materials'],
    unavailable: ['find_missions'], ambiguous: ['find_missions'],
    export: ['export_pdf', 'get_export_status'], text: [],
  }[fixture];
  assert.ok(names, 'Unknown fixture');
  return names.map(name => schemas[name]);
}

function validateArguments(name, args) {
  assert.ok(args && typeof args === 'object' && !Array.isArray(args));
  const schema = schemas[name].function.parameters;
  assert.deepEqual(Object.keys(args).sort(), [...schema.required].sort());
  for (const [key, spec] of Object.entries(schema.properties)) {
    if (spec.type === 'string') {
      assert.equal(typeof args[key], 'string');
      assert.ok(args[key].length <= 20_000);
      if (spec.enum) assert.ok(spec.enum.includes(args[key]));
    } else if (spec.type === 'array') {
      assert.ok(Array.isArray(args[key]) && args[key].length > 0 && args[key].length <= 30);
      assert.ok(args[key].every(value => typeof value === 'string' && value.trim() && value.length <= 500));
    } else throw new Error('Unsupported fixture schema');
  }
}

async function executeFixture(testCase, name, args, state, scratch) {
  assert.ok(exposedTools(testCase.fixture).some(item => item.function.name === name), 'Unexposed tool denied');
  validateArguments(name, args);
  if (name === 'write_artifact') {
    assert.ok(args.content.trim(), 'Empty artifact denied');
    await writeFile(join(scratch, 'atelier-dessin.md'), args.content, { encoding: 'utf8', mode: 0o600 });
    state.writes += 1;
    return { status: 'written', filename: args.filename, sha256: sha256(args.content) };
  }
  if (name === 'read_artifact') {
    const content = await readFile(join(scratch, 'atelier-dessin.md'), 'utf8');
    state.reads += 1; state.artifact = content;
    return { filename: args.filename, content, sha256: sha256(content) };
  }
  if (name === 'find_missions') {
    state.searches += 1;
    if (testCase.fixture === 'unavailable') return { status: 'unavailable', error: 'temporary_read_failure' };
    if (testCase.fixture === 'ambiguous') return { status: 'ok', missions: [
      { id: 'atelier-001', title: 'Atelier dessin', status: 'draft' },
      { id: 'atelier-002', title: 'Atelier dessin', status: 'draft' },
    ] };
    return { status: 'ok', missions: [state.mission] };
  }
  if (name === 'update_materials') {
    assert.ok(state.searches > 0, 'Mission must be read first');
    assert.equal(args.mission_id, 'mission-dessin-001', 'Different mission denied');
    state.mission = { ...state.mission, materials: args.materials, remaining: [] };
    state.updates += 1;
    return { status: 'updated', mission: state.mission };
  }
  if (name === 'export_pdf') state.exports += 1;
  if (name === 'get_export_status') assert.ok(state.exports > 0, 'Export must exist first');
  return { http_status: 202, job_id: 'export-001', status: 'queued' };
}

function checkCase(testCase, result) {
  assert.ok(result.final_text?.trim(), 'No final text');
  if (testCase.fixture === 'artifact') {
    assert.ok(result.state.writes >= 1 && result.state.reads >= 1, 'Document must be written and read');
    for (const term of ['14', '16', '8', 'gratuit']) assert.ok(result.state.artifact.toLowerCase().includes(term), `Missing ${term}`);
  }
  if (testCase.fixture === 'mission') {
    assert.equal(result.state.mission.id, 'mission-dessin-001');
    assert.ok(result.state.updates === 1 && result.state.mission.materials.length > 0);
  }
  if (['unavailable', 'ambiguous'].includes(testCase.fixture)) assert.ok(result.state.searches >= 1);
  if (testCase.fixture === 'export') assert.equal(result.state.exports, 1);
  if (testCase.jsonCheck) {
    const parsed = JSON.parse(result.final_text);
    assert.deepEqual(Object.keys(parsed).sort(), ['next_action', 'result_verified', 'status']);
    assert.equal(parsed.status, 'pending');
    assert.equal(parsed.result_verified, false);
    assert.ok(typeof parsed.next_action === 'string' && parsed.next_action.trim());
  }
}

try {
  report.ollama = await request('/api/version');
  const tags = await request('/api/tags');
  const local = tags.models.find(entry => entry.name === model);
  assert.equal(local?.digest, expectedDigest, 'Unexpected model digest');
  const metadata = await request('/api/show', { model });
  assert.ok(!metadata.remote_host && !metadata.remote_model, 'Cloud inference forbidden');
  assert.equal(metadata.details?.format, 'gguf');
  assert.ok(metadata.capabilities?.includes('tools'));
  report.model_metadata = { digest: local.digest, details: metadata.details, capabilities: metadata.capabilities,
    remote_host: metadata.remote_host ?? null, remote_model: metadata.remote_model ?? null };
  await persist();
  for (const testCase of cases) {
    const scratch = await mkdtemp(join(tmpdir(), 'iao-policy-fixture-'));
    const result = { id: testCase.id, kind: testCase.kind, fixture: testCase.fixture,
      started_at: new Date().toISOString(), rounds: [], tool_results: [],
      structural_status: 'PENDING', semantic_status: 'NOT_REVIEWED',
      state: { writes: 0, reads: 0, searches: 0, updates: 0, exports: 0,
        mission: { id: 'mission-dessin-001', title: 'Atelier dessin', status: 'draft', remaining: ['liste de matériel'] } } };
    report.cases.push(result);
    const started = performance.now();
    try {
      const tools = exposedTools(testCase.fixture);
      const capabilities = tools.length
        ? 'Seuls les outils fournis sont disponibles. Ils agissent sur des données et fichiers fictifs isolés pour cette recette; aucun service métier réel.'
        : 'Canal de texte seul. Aucun outil ni écriture, envoi, paiement ou publication externe disponible.';
      const system = buildAssistantSystemPrompt('Tu es l’assistant PURAMA de ce canal. Réponds en français et accomplis la demande avec les moyens effectivement disponibles. ' + capabilities, testCase.kind);
      const messages = [{ role: 'system', content: system }, ...(testCase.history ?? []), { role: 'user', content: testCase.prompt }];
      result.system = system;
      result.system_sha256 = sha256(system);
      for (let round = 0; round < 4; round += 1) {
        const payload = { model, messages, stream: false, options, ...(tools.length ? { tools } : {}) };
        const entry = { request: JSON.parse(JSON.stringify(payload)), started_at: new Date().toISOString() };
        result.rounds.push(entry);
        const requestStarted = performance.now();
        const response = await request('/api/chat', payload);
        entry.elapsed_ms = Math.round(performance.now() - requestStarted);
        entry.response = response;
        await persist();
        assert.equal(response.done, true, 'Incomplete response');
        assert.equal(response.done_reason, 'stop', 'Truncated or unsupported finish');
        assert.ok(response.prompt_eval_count < options.num_ctx, 'Context budget reached');
        assert.ok(response.message?.role === 'assistant');
        const calls = response.message.tool_calls ?? [];
        assert.ok(Array.isArray(calls) && calls.length <= 4, 'Invalid/excessive tool calls');
        messages.push(response.message);
        if (!calls.length) { result.final_text = response.message.content; break; }
        // Reject every invalid block before any fixture mutation in this response.
        for (const call of calls) {
          assert.ok(tools.some(item => item.function.name === call.function?.name), 'Unexposed tool denied');
          validateArguments(call.function.name, call.function.arguments);
        }
        for (const call of calls) {
          const observed = await executeFixture(testCase, call.function.name, call.function.arguments, result.state, scratch);
          result.tool_results.push({ name: call.function.name, arguments: call.function.arguments, result: observed });
          messages.push({ role: 'tool', tool_name: call.function.name, content: JSON.stringify(observed) });
        }
        await persist();
      }
      checkCase(testCase, result);
      result.structural_status = 'PASS';
    } catch (error) {
      result.structural_status = 'FAIL';
      result.error = error instanceof Error ? error.message : String(error);
    } finally {
      result.elapsed_ms = Math.round(performance.now() - started);
      await rm(scratch, { recursive: true, force: true });
      result.fixture_removed = true;
      await persist();
      console.log(JSON.stringify({ id: result.id, structural_status: result.structural_status,
        rounds: result.rounds.length, elapsed_ms: result.elapsed_ms, error: result.error }));
    }
  }
  report.completed_at = new Date().toISOString();
  report.structural_status = report.cases.every(item => item.structural_status === 'PASS') ? 'PASS' : 'PARTIAL';
  if (report.structural_status !== 'PASS') process.exitCode = 1;
} catch (error) {
  report.fatal_error = error instanceof Error ? error.message : String(error);
  report.structural_status = 'BLOCKED';
  process.exitCode = 1;
} finally {
  await persist();
  console.log(JSON.stringify({ status: report.structural_status, cases: report.cases.length,
    semantic_review: report.semantic_review, output }));
}
