import assert from 'node:assert/strict';
import Stripe from 'npm:stripe@19.0.0';
import { getHandler } from '../commerce/serve-capture.ts';
import { fixture, resetConnectFixture, seedConfirmedConnectAccount, syntheticCreationPolicy } from '../commerce/connect-provider-fixture.ts';
import { createConnectAccountHandler } from '../../supabase/functions/connect-account-session/index.ts';

// Stripe is the actual pinned package. Only server registration and the database
// are mapped. The real SDK serializes requests and parses local HTTP Responses.
// Creation cases use only the explicit offline policy; the actual served handler stays closed.
const handler = createConnectAccountHandler(syntheticCreationPolicy);
const servedHandler = getHandler();
const API_VERSION = '2025-09-30.clover';
const OPERATION = '00000000-0000-4000-8000-000000000001';
const ACCOUNT = 'acct_fixture_sdk';
const COMPONENTS = [
  'account_onboarding', 'account_management', 'notification_banner',
  'payouts', 'payments', 'balances', 'documents',
] as const;
const request = (body: unknown = {}) => new Request('https://fixture.invalid/connect-account-session', {
  method: 'POST',
  headers: { authorization: 'Bearer fixture-user-token', 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const jsonResponse = (body: unknown, status = 200, requestId = 'req_fixture_sdk') =>
  new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', 'request-id': requestId },
  });
const accountResponse = (metadata: Readonly<Record<string, string>> | null = {
  purama_connect_operation: OPERATION,
}) => jsonResponse({
  object: 'account', id: ACCOUNT, ...(metadata === null ? {} : { metadata }),
});
const sessionResponse = () => jsonResponse({
  object: 'account_session', account: ACCOUNT,
  client_secret: 'fixture-sdk-session-only', expires_at: 2000000000,
});
const errorResponse = (status = 400) => jsonResponse({
  error: {
    type: 'invalid_request_error', code: 'parameter_invalid_empty', param: 'country',
    message: 'fixture-private-provider-detail',
  },
}, status, 'req_fixture_error');

type CapturedRequest = {
  url: string; method: string; headers: Headers; body: string;
};
type TransportStep = {
  path: '/v1/accounts' | '/v1/account_sessions';
  respond: () => Response | Promise<Response>;
};
type TransportState = { requests: CapturedRequest[]; logs: unknown[][] };

async function withTransport(
  steps: readonly TransportStep[],
  exercise: (state: TransportState) => Promise<void>,
): Promise<void> {
  resetConnectFixture(); // Overwrites only the four allowed names with synthetic values.
  const previousFetch = globalThis.fetch;
  const previousError = console.error;
  const state: TransportState = { requests: [], logs: [] };
  const violations: string[] = [];
  const fetchInert: typeof fetch = async (input, init) => {
    const incoming = new Request(input, init);
    const url = new URL(incoming.url);
    const captured = {
      url: incoming.url, method: incoming.method,
      headers: new Headers(incoming.headers), body: await incoming.text(),
    };
    state.requests.push(captured);
    const step = steps[state.requests.length - 1];
    if (url.protocol !== 'https:' || url.hostname !== 'api.stripe.com'
      || url.port !== '' || url.search !== '' || url.username !== '' || url.password !== ''
      || incoming.method !== 'POST' || !step || url.pathname !== step.path) {
      violations.push('Unexpected inert SDK route or request count');
      throw new Error('Inert transport rejected request');
    }
    // Never call previousFetch. Even an unexpected route is handled locally.
    return await step.respond();
  };
  globalThis.fetch = fetchInert;
  console.error = (...args: unknown[]) => { state.logs.push(args); };
  try {
    await exercise(state);
  } finally {
    globalThis.fetch = previousFetch;
    console.error = previousError;
    // These assertions must stay outside the handler: its catch deliberately
    // converts exceptions to 503 and could otherwise hide a broken test fixture.
    assert.deepEqual(violations, []);
    assert.equal(state.requests.length, steps.length, 'Every expected HTTP exchange must occur');
  }
}

function assertHeaders(captured: CapturedRequest, idempotencyKey: string | null): void {
  assert.equal(captured.headers.get('stripe-version'), API_VERSION);
  assert.equal(captured.headers.get('authorization'), 'Bearer fixture-not-a-credential');
  assert.equal(captured.headers.get('content-type'), 'application/x-www-form-urlencoded');
  assert.equal(captured.headers.get('stripe-account'), null);
  assert.equal(captured.headers.get('idempotency-key'), idempotencyKey);
}

function assertForm(captured: CapturedRequest, expected: readonly (readonly [string, string])[]): void {
  // Compare entries, not Object.fromEntries: duplicate or additional fields fail.
  const sortEntries = (entries: readonly (readonly [string, string])[]) =>
    entries.map(([key, value]) => [key, value]).sort((a, b) =>
      a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  assert.deepEqual(sortEntries([...new URLSearchParams(captured.body)]), sortEntries(expected));
}

const accountForm: readonly (readonly [string, string])[] = [
  ['type', 'express'], ['country', 'FR'], ['email', 'fixture@example.invalid'],
  ['capabilities[transfers][requested]', 'true'],
  ['metadata[purama_connect_operation]', OPERATION],
];
const sessionForm = (components: readonly string[]): [string, string][] => [
  ['account', ACCOUNT],
  ...components.map((component): [string, string] => ['components[' + component + '][enabled]', 'true']),
];
const createStep = (): TransportStep => ({ path: '/v1/accounts', respond: accountResponse });
const sessionStep = (): TransportStep => ({ path: '/v1/account_sessions', respond: sessionResponse });

Deno.test('real Stripe SDK: API version, frozen account payload and all session components reach HTTP', async () => {
  assert.equal(Stripe.API_VERSION, API_VERSION);
  await withTransport([createStep(), sessionStep()], async ({ requests, logs }) => {
    const response = await handler(request());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      client_secret: 'fixture-sdk-session-only', expires_at: 2000000000, account_id: ACCOUNT,
    });
    assertHeaders(requests[0], 'connect-create:' + OPERATION);
    assertForm(requests[0], accountForm);
    assertHeaders(requests[1], null);
    assertForm(requests[1], sessionForm(COMPONENTS));
    assert.equal(fixture.persisted?.stripe_account_id, ACCOUNT);
    assert.deepEqual(logs, []);
  });
});

Deno.test('real Stripe SDK: the served handler opens only a session for a confirmed journal binding', async () => {
  await withTransport([sessionStep()], async ({ requests, logs }) => {
    await seedConfirmedConnectAccount(ACCOUNT);
    const original = structuredClone(fixture.operation);
    const response = await servedHandler(request({ components: ['balances', 'unknown', 'documents', 'balances'] }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      client_secret: 'fixture-sdk-session-only', expires_at: 2000000000, account_id: ACCOUNT,
    });
    assertHeaders(requests[0], null);
    assertForm(requests[0], sessionForm(['balances', 'documents']));
    assert.equal(fixture.claimArguments[0].p_parameters, null);
    assert.deepEqual(fixture.operation, original);
    assert.deepEqual(logs, []);
  });
});

Deno.test('real Stripe SDK: the served handler rejects new creation without any HTTP exchange', async () => {
  for (const body of [{}, { qualified: true, creation_enabled: true,
    parameters: { type: 'express', country: 'FR' } }]) {
    await withTransport([], async ({ logs }) => {
      const response = await servedHandler(request(body));
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(fixture.claimArguments[0].p_parameters, null);
      assert.equal(fixture.operation, null);
      assert.equal(fixture.persisted, null);
      assert.deepEqual(logs, []);
    });
  }
});

Deno.test('real Stripe SDK: the served handler rejects a historical binding without journal or HTTP', async () => {
  await withTransport([], async ({ logs }) => {
    fixture.lookup.data = { user_id: 'fixture-user-a', stripe_account_id: ACCOUNT };
    const original = structuredClone(fixture.lookup.data);
    const response = await servedHandler(request());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(fixture.claimArguments[0].p_parameters, null);
    assert.equal(fixture.operation, null);
    assert.deepEqual(fixture.lookup.data, original);
    assert.deepEqual(logs, []);
  });
});

Deno.test('real Stripe SDK: the served handler cannot resume pending creation or renew its lease', async () => {
  await withTransport([createStep()], async ({ requests }) => {
    fixture.finalizeResults.push('reject');
    assert.equal((await handler(request())).status, 503);
    const original = structuredClone(fixture.operation);
    assert.equal(original?.state, 'pending');
    fixture.now += 60001;
    assert.equal((await servedHandler(request())).status, 503);
    assert.equal(fixture.claimArguments.at(-1)!.p_parameters, null);
    assert.deepEqual(fixture.operation, original);
    assert.equal(fixture.persisted, null);
    assert.equal(requests.length, 1);
    assertHeaders(requests[0], 'connect-create:' + OPERATION);
    assertForm(requests[0], accountForm);
  });
});

Deno.test('real Stripe SDK: retry keeps the same serialized body and persisted idempotency key', async () => {
  await withTransport([createStep(), createStep(), sessionStep()], async ({ requests }) => {
    fixture.finalizeResults.push('reject');
    assert.equal((await handler(request())).status, 503);
    assert.deepEqual({ binding: fixture.persisted }, { binding: null });
    fixture.user!.email = 'changed@example.invalid';
    fixture.now += 60001;
    assert.equal((await handler(request())).status, 200);
    assert.equal(requests[0].body, requests[1].body);
    for (const captured of requests.slice(0, 2)) {
      assertHeaders(captured, 'connect-create:' + OPERATION);
      assertForm(captured, accountForm);
    }
    assert.equal(fixture.persisted?.stripe_account_id, ACCOUNT);
  });
});

Deno.test('real Stripe SDK: provider HTTP errors never expose their body or metadata through the handler', async () => {
  await withTransport([{ path: '/v1/accounts', respond: () => errorResponse() }], async ({ requests, logs }) => {
    const response = await handler(request());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Compte de paiement temporairement indisponible' });
    assert.deepEqual(logs, [['[connect-account-session] unavailable']]);
    assert.equal(fixture.persisted, null);
    assert.deepEqual(fixture.provisionEvents, ['claim_connect_account_provision']);
    assertHeaders(requests[0], 'connect-create:' + OPERATION);
  });
});

Deno.test('real Stripe SDK: a local HTTP error produces the genuine structured Stripe error', async () => {
  await withTransport([{ path: '/v1/accounts', respond: () => errorResponse() }], async ({ requests, logs }) => {
    const stripe = new Stripe('fixture-not-a-credential', {
      apiVersion: API_VERSION, httpClient: Stripe.createFetchHttpClient(),
      timeout: 10000, maxNetworkRetries: 0,
    });
    await assert.rejects(
      () => stripe.accounts.create({ country: 'FR' }, { idempotencyKey: 'fixture-direct-sdk' }),
      (error: unknown) => {
        assert.ok(error instanceof Stripe.errors.StripeInvalidRequestError);
        assert.equal(error.type, 'StripeInvalidRequestError');
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, 'parameter_invalid_empty');
        assert.equal(error.param, 'country');
        assert.equal(error.requestId, 'req_fixture_error');
        return true;
      },
    );
    assertHeaders(requests[0], 'fixture-direct-sdk');
    assertForm(requests[0], [['country', 'FR']]);
    assert.deepEqual(logs, []);
  });
});

for (const [name, metadata] of [
  ['absent', null],
  ['contradictory', { purama_connect_operation: 'another-operation' }],
] as const) {
  Deno.test('real Stripe SDK: ' + name + ' response metadata quarantines later sessions', async () => {
    await withTransport([{ path: '/v1/accounts', respond: () => accountResponse(metadata) }], async () => {
      assert.equal((await handler(request())).status, 503);
      assert.equal(fixture.operation?.state, 'reconcile');
      assert.equal(fixture.persisted, null);
      fixture.now += 60001;
      assert.equal((await handler(request())).status, 503);
    });
  });
}

Deno.test('real Stripe SDK: a failed session leaves the confirmed account reusable', async () => {
  await withTransport([
    createStep(), { path: '/v1/account_sessions', respond: () => errorResponse() }, sessionStep(),
  ], async ({ requests, logs }) => {
    assert.equal((await handler(request({ components: ['balances'] }))).status, 503);
    assert.equal(fixture.persisted?.stripe_account_id, ACCOUNT);
    assert.equal((await handler(request({ components: ['balances'] }))).status, 200);
    for (const captured of requests.slice(1)) {
      assertHeaders(captured, null);
      assertForm(captured, sessionForm(['balances']));
    }
    assert.deepEqual(logs, [['[connect-account-session] unavailable']]);
  });
});

Deno.test('real Stripe SDK: connection-closed retry preserves the creation key and encoded parameters', async () => {
  await withTransport([
    { path: '/v1/accounts', respond: () => { throw Object.assign(new Error('fixture-closed'), { code: 'ECONNRESET' }); } },
    createStep(), sessionStep(),
  ], async ({ requests }) => {
    assert.equal((await handler(request())).status, 200);
    assert.equal(requests[0].body, requests[1].body);
    for (const captured of requests.slice(0, 2)) assertHeaders(captured, 'connect-create:' + OPERATION);
    assert.equal(fixture.persisted?.stripe_account_id, ACCOUNT);
  });
});

Deno.test('real Stripe SDK: an HTTP 500 does not cause another attempt with maxNetworkRetries zero', async () => {
  await withTransport([{ path: '/v1/accounts', respond: () => errorResponse(500) }], async ({ requests, logs }) => {
    assert.equal((await handler(request())).status, 503);
    assert.equal(fixture.persisted, null);
    assertHeaders(requests[0], 'connect-create:' + OPERATION);
    assert.deepEqual(logs, [['[connect-account-session] unavailable']]);
  });
});

Deno.test('real Stripe SDK: an expired claim reaches no HTTP transport', async () => {
  await withTransport([], async ({ logs }) => {
    fixture.claimOverride = { lease_until: new Date(fixture.now - 1).toISOString() };
    assert.equal((await handler(request())).status, 503);
    assert.equal(fixture.persisted, null);
    assert.deepEqual(logs, []);
  });
});
