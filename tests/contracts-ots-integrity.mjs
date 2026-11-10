import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, webcrypto } from 'node:crypto';
import { harness, request, noStampEffects, OpenTimestamps, contractId, serviceKey, webhookSecret, docusealToken, docusealOrigin, defaultPdfUrl, foreignPdfUrl } from './ots-edge-fixture.mjs';

for (const authorization of [null, 'Bearer wrong', `Bearer ${webhookSecret}x`, `Bearer ${webhookSecret.slice(0, -1)}x`]) {
  test(`unauthorized webhook never reads body: ${authorization}`, async () => {
    const h = await harness({}, 'contracts-webhook');
    let reads = 0;
    let controller;
    const body = new ReadableStream({
      start(value) { controller = value; },
      pull() { reads++; },
    }, { highWaterMark: 0 });
    const headers = new Headers();
    if (authorization !== null) headers.set('Authorization', authorization);
    const req = new Request('https://edge.example.invalid/webhook', {
      method: 'POST', headers, body, duplex: 'half',
    });
    let timer;
    try {
      const response = await Promise.race([h.handler(req), new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Invalid bearer waited for request body')), 250);
      })]);
      assert.equal(response.status, 401);
      assert.equal(reads, 0);
      assert.equal(req.bodyUsed, false);
      assert.equal(h.calls.clients.length, 0);
      noStampEffects(h.calls);
    } finally {
      clearTimeout(timer);
      controller.close();
    }
  });
}


for (const token of [null, '', 'invalid-token', `${serviceKey}x`, 'fake.jwt.service_role']) {
  test(`rejects unauthenticated credential ${JSON.stringify(token)} before any contract effects`, async () => {
    const h = await harness();
    assert.equal((await h.handler(request(token))).status, 401);
    noStampEffects(h.calls);
  });
}
test('ordinary user cannot elevate via metadata, body identity or role', async () => {
  const h = await harness();
  const response = await h.handler(request('member-token', { contract_id: contractId, user_id: 'server-admin', role: 'admin' }));
  assert.equal(response.status, 403);
  assert.deepEqual(h.calls.auth, ['member-token']);
  assert.equal(h.calls.roles[0].args._user_id, 'ordinary-member');
  noStampEffects(h.calls);
});
for (const [label, options, status] of [
  ['invalidated user', { authError: true }, 401],
  ['removed role', { noRole: true }, 403],
  ['different role', { role: 'member' }, 403],
  ['role lookup failure', { roleError: true }, 503],
  ['auth provider failure', { authThrows: true }, 503],
  ['missing service configuration', { env: { SUPABASE_SERVICE_ROLE_KEY: '' } }, 503],
  ['missing service URL', { env: { SUPABASE_URL: '' } }, 503],
]) {
  test(`fails closed on ${label}`, async () => {
    const h = await harness(options);
    const response = await h.handler(request());
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /private-/);
    noStampEffects(h.calls);
  });
}
for (const token of ['admin-token', serviceKey]) {
  test(`allows ${token === serviceKey ? 'exact internal credential' : 'verified current admin'} and clears stale Bitcoin confirmation`, async () => {
    const h = await harness();
    const response = await h.handler(request(token, { contract_id: contractId, actor_id: 'forged' }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.pending_bitcoin_confirmation, true);
    assert.equal(h.calls.stamps.length, 1);
    const proof = OpenTimestamps.DetachedTimestampFile.deserialize([...Buffer.from(h.contract.ots_proof, 'base64')]);
    assert.equal(Buffer.from(proof.fileDigest()).toString('hex'), result.hash);
    assert.equal(h.contract.ots_verified_at, null);
    assert.equal(h.contract.ots_block_height, null);
    assert.equal(h.contract.ots_btc_timestamp, null);
    assert.equal(h.calls.events.length, 1);
    assert.equal(h.calls.events[0].actor_id, token === serviceKey ? null : 'server-admin');
    assert.equal(h.calls.events[0].actor_type, token === serviceKey ? 'service' : 'user');
    if (token === serviceKey) assert.equal(h.calls.auth.length + h.calls.roles.length, 0);
  });
}
test('handles preflight without data access and refuses unsupported methods', async () => {
  const h = await harness();
  assert.equal((await h.handler(request(null, undefined, 'OPTIONS'))).status, 200);
  assert.equal((await h.handler(request(null, undefined, 'GET'))).status, 405);
  assert.equal(h.calls.clients.length, 0);
});
for (const body of [null, [], {}, { contract_id: 42 }, { contract_id: 'not-a-uuid' }, '{']) {
  test(`rejects malformed input ${JSON.stringify(body)} before contract access`, async () => {
    const h = await harness();
    assert.equal((await h.handler(request('admin-token', body))).status, 400);
    noStampEffects(h.calls);
  });
}
for (const status of ['draft', 'sent', 'opened', 'declined', 'cancelled', 'expired']) {
  test(`refuses stamping a ${status} contract before provider access`, async () => {
    const h = await harness({ status });
    assert.equal((await h.handler(request())).status, 409);
    assert.equal(h.calls.docs.length + h.calls.pdf.length + h.calls.stamps.length + h.calls.updates.length, 0);
  });
}
for (const [label, options, status] of [
  ['missing contract', { noContract: true }, 404],
  ['database read error', { loadError: true }, 503],
  ['missing submission', { noSubmission: true }, 409],
  ['missing signed PDF', { noPdf: true }, 502],
  ['provider PDF error', { pdfStatus: 503 }, 502],
  ['provider PDF exception', { pdfThrows: true }, 502],
  ['provider stamp exception', { stampThrows: true }, 502],
  ['proof write error', { updateError: true }, 500],
  ['audit write error', { eventError: true }, 500],
]) {
  test(`does not report success after ${label}`, async () => {
    const h = await harness(options);
    const response = await h.handler(request());
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /private-/);
  });
}
for (const option of ['cancelDuringFetch', 'replaceSubmissionDuringFetch']) {
  test(`does not overwrite a contract changed during PDF retrieval: ${option}`, async () => {
    const h = await harness({ [option]: true });
    assert.equal((await h.handler(request())).status, 409);
    assert.equal(h.contract.ots_proof, 'old-proof');
    assert.equal(h.calls.events.length, 0);
  });
}
test('does not persist or report a pending proof when every calendar failed', async () => {
  const h = await harness({ allCalendarsFail: true });
  const response = await h.handler(request());
  assert.equal(response.status, 502);
  assert.equal(h.calls.stamps.length, 1);
  assert.equal(h.calls.stamps[0].timestamp.allAttestations().size, 0);
  assert.equal(h.calls.updates.length + h.calls.events.length, 0);
  assert.equal(h.contract.ots_proof, 'old-proof');
});
for (const pdfUrl of [defaultPdfUrl, `${docusealOrigin}.attacker.invalid/signed.pdf`, foreignPdfUrl]) {
  test(`PDF credentials and requests are limited to the exact configured origin: ${pdfUrl}`, async () => {
    const h = await harness({ pdfUrl });
    const trusted = new URL(pdfUrl).origin === docusealOrigin;
    assert.equal((await h.handler(request())).status, trusted ? 200 : 502);
    if (trusted) {
      assert.equal(new Headers(h.calls.pdf[0].init.headers).get('X-Auth-Token'), docusealToken);
      assert.equal(h.calls.pdf[0].init.redirect, 'error');
    } else {
      assert.equal(h.calls.pdf.length + h.calls.stamps.length + h.calls.updates.length, 0);
    }
  });
}
for (const pdfUrl of ['http://files.example.invalid/signed.pdf', 'https://user@files.example.invalid/signed.pdf', 'data:application/pdf;base64,AA==']) {
  test(`rejects unsafe PDF location before fetching: ${pdfUrl}`, async () => {
    const h = await harness({ pdfUrl });
    assert.equal((await h.handler(request())).status, 502);
    assert.equal(h.calls.pdf.length + h.calls.stamps.length, 0);
  });
}

function webhookRequest(headers = {}) {
  const body = JSON.stringify({ event_type: 'submission.created', data: { id: 42 } });
  return new Request('https://edge.example.invalid/webhook', { method: 'POST', headers, body });
}
for (const environment of [undefined, 'production', 'staging', 'development', 'local', 'test']) {
  test(`reused webhook guard fails closed without a secret in ${String(environment)}`, async () => {
    const h = await harness({ env: { DOCUSEAL_WEBHOOK_SECRET: '', DENO_ENV: environment } }, 'contracts-webhook');
    assert.equal((await h.handler(webhookRequest())).status, 503);
    noStampEffects(h.calls);
    assert.equal(h.calls.clients.length, 0);
  });
}
test('reused webhook guard rejects an invalid provider credential before privileged reads', async () => {
  const h = await harness({}, 'contracts-webhook');
  assert.equal((await h.handler(webhookRequest({ Authorization: 'Bearer invalid' }))).status, 401);
  noStampEffects(h.calls);
});
for (const transport of ['bearer', 'hmac']) {
  test(`reconciled webhook contract accepts authenticated ${transport} delivery`, async () => {
    const h = await harness({}, 'contracts-webhook');
    const body = JSON.stringify({ event_type: 'submission.created', data: { id: 42 } });
    const headers = transport === 'bearer' ? { Authorization: `Bearer ${webhookSecret}` }
      : { 'x-docuseal-signature': `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}` };
    assert.equal((await h.handler(webhookRequest(headers))).status, 200);
    assert.equal(h.calls.events.length, 1);
    assert.equal(h.calls.internal.length, 0);
  });
}
test('authenticated completion delivers the internal credential to the actual stamp handler', async () => {
  const stamp = await harness({ status: 'sent' });
  let pendingStamp;
  const webhook = await harness({
    contractState: stamp.contract,
    internalHandler: req => { pendingStamp = stamp.handler(req); return pendingStamp; },
  }, 'contracts-webhook');
  const response = await webhook.handler(new Request('https://edge.example.invalid/webhook', {
    method: 'POST', headers: { Authorization: `Bearer ${webhookSecret}` },
    body: JSON.stringify({ event_type: 'form.completed', data: { id: 7, submission_id: 42 } }),
  }));
  assert.equal(response.status, 200);
  assert.equal(webhook.calls.internal.length, 1);
  assert.equal((await pendingStamp).status, 200);
  assert.equal(stamp.contract.status, 'signed');
  assert.equal(stamp.calls.stamps.length, 1);
  assert.equal(stamp.calls.events[0].actor_type, 'service');
  assert.equal(stamp.calls.auth.length + stamp.calls.roles.length, 0);
});

for (const failure of ['pdfThrows', 'stampThrows']) {
  test(`provider-private details are absent from response and logs: ${failure}`, async () => {
    const h = await harness({ [failure]: true });
    const response = await h.handler(request());
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /private-/);
    assert.doesNotMatch(h.calls.errors.map(args => args.map(String).join(' ')).join(' '), /private-/);
  });
}

test('incoming cancellation during PDF retrieval prevents a stamp and persistence', async () => {
  const controller = new AbortController(); const h = await harness();
  const pending = h.handler(new Request(request(), { signal: controller.signal }));
  for (let i = 0; i < 100 && h.calls.pdf.length === 0; i++) await Promise.resolve();
  assert.equal(h.calls.pdf.length, 1, 'fixture must reach the PDF response before cancellation');
  controller.abort();
  assert.equal((await pending).status, 502);
  assert.equal(h.calls.stamps.length + h.calls.updates.length + h.calls.events.length, 0);
});

test('incoming cancellation while hashing prevents the first external stamp effect', async () => {
  const controller = new AbortController(); let hashes = 0;
  const h = await harness({ crypto: { getRandomValues: array => webcrypto.getRandomValues(array), subtle: { digest: async (...args) => {
    hashes++; const hash = await webcrypto.subtle.digest(...args); controller.abort(); return hash;
  } } } });
  const result = await h.handler(new Request(request(), { signal: controller.signal }));
  assert.equal(hashes, 1);
  assert.equal(h.calls.stamps.length + h.calls.updates.length + h.calls.events.length, 0);
  assert.equal(result.status, 408);
  assert.equal(h.contract.ots_proof, 'old-proof');
});

for (const phase of ['reauthorization', 'hashing']) {
  test(`the signed-document window still applies after ${phase} and before the first stamp`, async () => {
    let clock = 0, hashes = 0;
    const h = await harness({ performance: { now: () => clock },
      onAuthorization: count => { if (phase === 'reauthorization' && count === 2) clock = 15_001; },
      crypto: { getRandomValues: array => webcrypto.getRandomValues(array), subtle: { digest: async (...args) => {
        hashes++; const hash = await webcrypto.subtle.digest(...args);
        if (phase === 'hashing') clock = 15_001;
        return hash;
      } } } });
    const result = await h.handler(request());
    assert.equal(h.calls.stamps.length + h.calls.updates.length + h.calls.events.length, 0);
    assert.equal(result.status, 502);
    assert.equal(hashes, phase === 'hashing' ? 1 : 0);
    assert.equal(h.contract.ots_proof, 'old-proof');
  });
}

test('stamping hashes the exact signed binary bytes, including non-UTF-8 octets', async () => {
  const bytes = new Uint8Array([...new TextEncoder().encode('%PDF-'), 0, 128, 255, 10]);
  const expected = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const h = await harness({ pdfBytes: bytes });
  const result = await h.handler(request());
  assert.equal(result.status, 200);
  assert.equal((await result.json()).hash, expected);
  assert.equal(Buffer.from(h.calls.stamps[0].fileDigest()).toString('hex'), expected);
});
