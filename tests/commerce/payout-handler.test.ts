import assert from 'node:assert/strict';
import { getHandler } from './serve-capture.ts';
import { effects, resetEffects } from './payout-provider-fixture.ts';
import '../../supabase/functions/process-influencer-payments/index.ts';

const handler = getHandler();
const secret = 'fixture-cron-secret';
const request = (method: string, suppliedSecret?: string) => new Request('https://fixture.invalid/payout', {
  method,
  headers: suppliedSecret === undefined ? {} : { 'x-webhook-secret': suppliedSecret },
});

Deno.test('payout: CORS preflight does not access money or external services', async () => {
  resetEffects();
  const response = await handler(request('OPTIONS'));
  assert.equal(response.status, 200);
  assert.notEqual(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.deepEqual(effects, { clients: 0, writes: [], emails: [] });
});

for (const method of ['GET', 'PUT', 'DELETE']) {
  Deno.test(`payout: ${method} cannot invoke a payout`, async () => {
    resetEffects(); Deno.env.set('WEBHOOK_SECRET', secret);
    const response = await handler(request(method, secret));
    assert.equal(response.status, 405);
    assert.deepEqual(effects, { clients: 0, writes: [], emails: [] });
  });
}

Deno.test('payout: missing server secret fails closed', async () => {
  resetEffects(); Deno.env.delete('WEBHOOK_SECRET');
  const response = await handler(request('POST'));
  assert.equal(response.status, 503);
  assert.deepEqual(effects, { clients: 0, writes: [], emails: [] });
});

for (const suppliedSecret of [undefined, '', 'incorrect']) {
  Deno.test(`payout: invalid credential ${JSON.stringify(suppliedSecret)} is rejected`, async () => {
    resetEffects(); Deno.env.set('WEBHOOK_SECRET', secret);
    const response = await handler(request('POST', suppliedSecret));
    assert.equal(response.status, 401);
    assert.deepEqual(effects, { clients: 0, writes: [], emails: [] });
  });
}

Deno.test('payout: an authenticated cron cannot mark paid or announce a transfer without a provider', async () => {
  resetEffects(); Deno.env.set('WEBHOOK_SECRET', secret);
  Deno.env.set('RESEND_API_KEY', 'fixture-no-network');
  const response = await handler(request('POST', secret));
  const body = await response.json();
  // Verify effects first: the historic implementation marks a 75 EUR fixture paid here.
  assert.deepEqual(effects, { clients: 0, writes: [], emails: [] });
  assert.equal(response.status, 503);
  assert.equal(body.success, false);
  assert.equal(body.processed, 0);
  assert.match(body.error, /prestataire/i);
});
