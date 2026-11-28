// Independent native HTTP/1.1 pipelining probe. No product files are written.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');

const root = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const projectRequire = createRequire(path.join(root, 'package.json'));
const ts = projectRequire('typescript');
const started = performance.now();
const result = {
  schema: 'purama.iao.independent-http-pipeline-probe.v1',
  observedAt: new Date().toISOString(),
  node: process.version,
  repositoryDirectory: path.dirname(root),
  sourceHashes: {},
  method: 'Actual TypeScript modules transpiled in memory; native node:http and one node:net loopback socket; unrelated dependencies replaced by fixtures.',
  productWrites: 0,
  physicalInference: false,
  fixtureAuthority: true,
  checks: {},
  timeline: [],
};
const tick = (event, data = {}) => {
  const entry = { event, elapsedMs: Number((performance.now() - started).toFixed(3)), ...data };
  result.timeline.push(entry);
  console.log(JSON.stringify(entry));
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const cache = new Map();
const stubs = {
  '../config.js': { config: { port: 0, adminToken: 'review-fixture', mockClaude: true } },
  '../db/supabase.js': { supabase: {} },
  '../agents/index.js': { AGENT_REGISTRY: {} },
  './consultation.js': { handleConsultationRequest: async () => false },
};
function load(rel) {
  const file = path.resolve(root, rel);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const source = fs.readFileSync(file, 'utf8');
  result.sourceHashes[path.relative(root, file)] = createHash('sha256').update(source).digest('hex');
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const localRequire = id => {
    if (id.startsWith('node:')) return require(id);
    if (Object.hasOwn(stubs, id)) return stubs[id];
    if (/iaoRoutes|iaoFacade|kartaRuntimePort/.test(id)) {
      return load(path.relative(root, path.resolve(path.dirname(file), id.replace(/\.js$/, '.ts'))));
    }
    return {};
  };
  vm.runInThisContext('(function(require,module,exports){' + javascript + '\n})', { filename: file })(localRequire, module, module.exports);
  return module.exports;
}
function takeResponse(buffer) {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd < 0) return null;
  const lines = buffer.subarray(0, headerEnd).toString('latin1').split('\r\n');
  const status = Number(lines.shift().split(' ')[1]);
  const headers = Object.fromEntries(lines.map(line => {
    const at = line.indexOf(':');
    return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()];
  }));
  let offset = headerEnd + 4;
  const parts = [];
  if (headers['transfer-encoding'] === 'chunked') {
    while (true) {
      const lineEnd = buffer.indexOf('\r\n', offset);
      if (lineEnd < 0) return null;
      const size = Number.parseInt(buffer.subarray(offset, lineEnd).toString('ascii').split(';')[0], 16);
      assert.ok(Number.isFinite(size), 'valid HTTP chunk size');
      offset = lineEnd + 2;
      if (size === 0) {
        if (buffer.length < offset + 2) return null;
        assert.equal(buffer.subarray(offset, offset + 2).toString(), '\r\n', 'fixture has no trailers');
        offset += 2;
        break;
      }
      if (buffer.length < offset + size + 2) return null;
      parts.push(buffer.subarray(offset, offset + size));
      offset += size + 2;
    }
  } else {
    const size = Number(headers['content-length']);
    assert.ok(Number.isFinite(size), 'known response body framing');
    if (buffer.length < offset + size) return null;
    parts.push(buffer.subarray(offset, offset + size));
    offset += size;
  }
  return { consumed: offset, response: { status, headers, body: JSON.parse(Buffer.concat(parts).toString('utf8')) } };
}

(async () => {
  const workEntered = deferred(), completion = deferred(), authEntered = deferred(), lateAuth = deferred();
  const secondEnded = deferred(), bothReceived = deferred();
  void secondEnded.promise.catch(() => {});
  void bothReceived.promise.catch(() => {});
  let server, client, watchdog, workSignal;
  const requestId = '11111111-1111-4111-8111-111111111111';
  const operationId = '33333333-3333-4333-8333-333333333333';
  const calls = { submit: 0, get: 0, cancel: 0, buildContext: 0, complete: 0, control: 0, authenticate: 0 };
  const requests = [], wireResponses = [];
  let received = Buffer.alloc(0);
  function identity() {
    const now = Date.now();
    return { tenantId: 'review-tenant', actorId: 'review-actor', session: {
      tenantId: 'review-tenant', userId: 'review-actor', sessionId: '22222222-2222-4222-8222-222222222222',
      appSlug: 'purama-ai', issuedAt: now - 1000, expiresAt: now + 60000,
    } };
  }
  try {
    const { IaoFacade } = load('src/iao/iaoFacade.ts');
    const { KartaRuntimeIaoPort } = load('src/iao/kartaRuntimePort.ts');
    const { startApiServer } = load('src/api/server.ts');
    const port = new KartaRuntimeIaoPort({
      buildContext: async () => { calls.buildContext++; return { operationId, context: { sources: [] } }; },
      control: async () => { calls.control++; throw new Error('unexpected memory-control fixture'); },
    }, { complete: async input => {
      calls.complete++; workSignal = input.signal; tick('first_completion_entered'); workEntered.resolve(); return completion.promise;
    } });
    const facade = new IaoFacade(port);
    const inspect = facade.get.bind(facade);
    for (const method of ['submit', 'get', 'cancel']) {
      const original = facade[method].bind(facade);
      facade[method] = (...args) => { calls[method]++; return original(...args); };
    }
    server = startApiServer(async () => ({ ready: true, phase: 'ready' }), {
      consultationHost: null,
      iaoRuntime: { facade, authenticator: { authenticate: async req => {
        calls.authenticate++;
        if (req.headers['x-review-slow-auth']) {
          tick('second_authentication_entered'); authEntered.resolve(); await lateAuth.promise;
          tick('late_authentication_released');
        }
        return identity();
      } } },
    });
    server.on('request', (req, res) => {
      const index = requests.length;
      requests.push({ req, res });
      const end = res.end;
      res.end = function (...args) {
        tick('response_end_called', { index, status: res.statusCode });
        const returned = end.apply(this, args);
        if (index === 1) secondEnded.resolve();
        return returned;
      };
    });
    await once(server, 'listening');
    watchdog = setTimeout(() => {
      const error = new Error('native probe exceeded 25000 ms');
      secondEnded.reject(error); bothReceived.reject(error);
      client?.destroy(error);
    }, 25000);
    client = net.connect(server.address().port, '127.0.0.1');
    client.on('error', error => { tick('socket_error', { code: error.code, message: error.message }); bothReceived.reject(error); });
    client.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      try {
        let next;
        while ((next = takeResponse(received))) {
          received = received.subarray(next.consumed);
          wireResponses.push(next.response);
          tick('response_received_on_wire', { index: wireResponses.length - 1, status: next.response.status });
          if (wireResponses.length === 2) bothReceived.resolve();
        }
      } catch (error) { bothReceived.reject(error); }
    });
    await once(client, 'connect');
    const body = JSON.stringify({ type: 'conversation', requestId, conversationId: 'review', prompt: 'fixture' });
    client.write('POST /iao/requests HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
    await workEntered.promise;
    result.firstSocketTimeoutMs = requests[0].req.socket.timeout;
    result.serverTimeoutMs = server.timeout;
    client.write('GET /iao/requests/' + requestId + ' HTTP/1.1\r\nHost: localhost\r\nX-Review-Slow-Auth: yes\r\nConnection: keep-alive\r\n\r\n');
    await authEntered.promise;
    result.sameConnection = requests[0].req.socket === requests[1].req.socket;
    result.secondSocketTimeoutMs = requests[1].req.socket.timeout;
    await secondEnded.promise;
    await new Promise(resolve => setImmediate(resolve));
    const firstState = inspect('review-tenant', 'review-actor', requestId);
    result.atSecondExpiry = {
      firstStatus: firstState.status, firstSignalAborted: workSignal.aborted,
      secondResponseStatus: requests[1].res.statusCode, secondResponseEnded: requests[1].res.writableEnded,
      calls: { ...calls }, wireResponseCount: wireResponses.length,
    };
    assert.equal(result.sameConnection, true);
    assert.equal(result.secondSocketTimeoutMs, 241000);
    assert.equal(firstState.status, 'draft');
    assert.equal(workSignal.aborted, false);
    assert.equal(requests[1].res.statusCode, 503);
    assert.equal(requests[1].res.writableEnded, true);
    assert.deepEqual([calls.submit, calls.get, calls.cancel], [1, 0, 0]);
    result.checks.independentAdmissionDeadline = 'PASS';
    lateAuth.resolve();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([calls.submit, calls.get, calls.cancel], [1, 0, 0]);
    result.callsAfterLateAuthentication = { ...calls };
    result.checks.lateAuthenticationCannotAccessFacade = 'PASS';
    let drained = false;
    const draining = server.drainRequests().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    result.drainPendingBeforeCompletion = true;
    completion.resolve({ text: 'independent pipeline fixture completed', modelVersion: 'fixture-no-physical-inference' });
    await draining;
    await bothReceived.promise;
    assert.equal(wireResponses[0].status, 202);
    assert.equal(wireResponses[0].body.status, 'verified');
    assert.equal(wireResponses[1].status, 503);
    assert.deepEqual(wireResponses[1].body, { error: 'IAO runtime unavailable' });
    assert.equal(wireResponses[1].headers['cache-control'], 'no-store');
    assert.equal(calls.complete, 1);
    assert.equal(calls.buildContext, 1);
    result.checks.firstAdmittedTaskContinuesAndVerifies = 'PASS';
    result.checks.wireResponsesAre202Then503 = 'PASS';
    result.checks.activeDrainWaitsForAdmittedCompletion = 'PASS';
    result.wireResponses = wireResponses;
    result.finalCalls = { ...calls };
    result.verdict = 'PASS';
    tick('probe_pass');
  } catch (error) {
    result.verdict = 'FAIL';
    result.failure = { name: error.name, message: error.message, stack: error.stack };
    tick('probe_fail', { message: error.message });
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    lateAuth.resolve(); completion.resolve({ text: 'fixture cleanup', modelVersion: 'fixture-no-physical-inference' });
    client?.destroy();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await server.drainRequests(); }
    result.durationMs = Number((performance.now() - started).toFixed(3));
    result.sourceHashesAfter = Object.fromEntries(Object.keys(result.sourceHashes).map(rel => [rel, createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex')]));
    result.sourcesStableDuringProbe = JSON.stringify(result.sourceHashes) === JSON.stringify(result.sourceHashesAfter);
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ verdict: result.verdict, output, sourcesStableDuringProbe: result.sourcesStableDuringProbe }));
  }
})();
