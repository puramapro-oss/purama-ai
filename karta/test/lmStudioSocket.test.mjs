// Real Node HTTP sockets + real SDK, synthetic server only. No model inference.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.ANTHROPIC_API_KEY = 'fixture-cloud-key';
process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-cloud-token';
process.env.ANTHROPIC_BASE_URL = 'https://unreachable-fixture.invalid';
process.env.KARTA_MODEL_TIMEOUT_MS = '1000';
const { createRealClaudeClient } = await import('../src/claude/real.ts');
const model = 'loaded-heretic-fixture';
const requests = [];
let responseMode = 'text';
let redirectHits = 0;
let origin;
let redirectOrigin;
const redirectServer = createServer((_req, res) => { redirectHits++; res.end('must not be reached'); });
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  requests.push({ path: req.url, method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : null });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/v1/models') {
    res.end(JSON.stringify({ models: [{ type: 'llm', format: 'gguf', key: model,
      loaded_instances: [{ id: model }], capabilities: { trained_for_tool_use: true } }] }));
    return;
  }
  if (responseMode === 'redirect') { res.writeHead(307, { location: redirectOrigin }); res.end(); return; }
  if (responseMode === 'oversize') { res.end('x'.repeat(2 * 1024 * 1024 + 1)); return; }
  const content = responseMode === 'tool'
    ? [{ type: 'tool_use', id: 'tool_fixture', name: 'prepare_fixture', input: { title: 'Création à Frasne' } }]
    : [{ type: 'text', text: 'Bonjour depuis le serveur local de test.' }];
  res.end(JSON.stringify({ id: 'msg_socket_fixture', type: 'message', role: 'assistant', model, content,
    stop_reason: responseMode === 'tool' ? 'tool_use' : responseMode === 'truncated' ? 'max_tokens' : 'end_turn',
    stop_sequence: null, usage: { input_tokens: 12, output_tokens: 8 } }));
});
const listen = target => new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
const close = target => new Promise(resolve => { target.close(resolve); target.closeAllConnections(); });
before(async () => {
  await listen(server); await listen(redirectServer);
  origin = `http://127.0.0.1:${server.address().port}`;
  redirectOrigin = `http://127.0.0.1:${redirectServer.address().port}`;
});
after(async () => { await close(server); await close(redirectServer); });
const client = () => createRealClaudeClient({ lmStudio: { model, baseURL: origin, apiKey: 'fixture-local-token' } });
const input = () => ({ agentType: 'local-socket-fixture', systemPrompt: 'Réponds en français.', context: { title: 'Création à Frasne' }, tools: [] });

test('real socket: local inventory, credentials, exact model and token receipt', async () => {
  requests.length = 0; responseMode = 'text';
  const receipts = [];
  const result = await client().decide({ ...input(), onUsage: value => receipts.push(value) });
  assert.equal(result.summary, 'Bonjour depuis le serveur local de test.');
  assert.equal(result.mock, false);
  assert.deepEqual(requests.map(request => request.path), ['/api/v1/models', '/v1/messages']);
  assert.equal(requests[0].headers.authorization, 'Bearer fixture-local-token');
  assert.equal(requests[1].headers.authorization, undefined);
  assert.equal(requests[1].headers['x-api-key'], 'fixture-local-token');
  assert.equal(requests[1].body.model, model);
  assert.equal(receipts[0].inputTokens, 12);
  assert.equal(receipts[0].routeKind, 'compatible');
});

test('real socket: tool decision validates but executes no tool', async () => {
  responseMode = 'tool';
  let executed = 0;
  const result = await client().decide({ ...input(), tools: [{ name: 'prepare_fixture', description: 'Test synthétique', sensitive: false,
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false },
    execute: async () => { executed++; throw new Error('Tools must not run'); },
  }] });
  assert.deepEqual(result.toolCalls, [{ tool: 'prepare_fixture', params: { title: 'Création à Frasne' } }]);
  assert.equal(executed, 0);
});

test('real socket: redirects do not forward the prompt or local token', async () => {
  responseMode = 'redirect'; requests.length = 0;
  await assert.rejects(client().decide(input()), /aucune décision disponible/);
  assert.equal(redirectHits, 0);
  assert.equal(requests.length, 2);
});

test('real socket: a truncated answer is rejected with no retry', async () => {
  responseMode = 'truncated'; requests.length = 0;
  await assert.rejects(client().decide(input()), /incomplète/);
  assert.equal(requests.length, 2);
});

test('real socket: oversized inference body is bounded with no retry', async () => {
  responseMode = 'oversize'; requests.length = 0;
  await assert.rejects(client().decide(input()), /aucune décision disponible/);
  assert.equal(requests.length, 2);
});
