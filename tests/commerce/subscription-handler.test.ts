import assert from 'node:assert/strict';
import { fixture, resetFixture } from './subscription-provider-fixture.ts';
import { getHandler } from './serve-capture.ts';
import '../../supabase/functions/check-subscription/index.ts';

Deno.env.set('STRIPE_SECRET_KEY', 'sk_test_fixture_only');
Deno.env.set('SUPABASE_URL', 'https://fixture.invalid');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-role');
Deno.env.set('PURAMA_BILLING_ORIGIN', 'https://billing.fixture.invalid');
const handler = getHandler();
const end = 1_800_000_000;
const subscription = { status: 'active', items: { data: [{ price: { product: 'prod_UHwPSU2o4DW6Ej' }, current_period_end: end }] } };
const request = () => new Request('https://fixture.invalid/subscription', { method: 'POST', headers: { Authorization: 'Bearer fixture' } });
function test(name: string, run: () => Promise<void>): void {
  Deno.test(name, async () => {
    resetFixture();
    await run();
    assert.deepEqual(fixture.customerCreations, [], 'This read endpoint must never create a customer');
  });
}

test('subscription edge: real handler accepts a Basil payload without top-level period', async () => {
  fixture.subscriptions = [subscription]; fixture.calls = [];
  const response = await handler(request()); const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, { subscribed: true, plan_type: 'pro', product_id: 'prod_UHwPSU2o4DW6Ej', subscription_end: new Date(end * 1000).toISOString() });
  assert.deepEqual(fixture.calls, [{ customer: 'cus_fixture', status: 'active', limit: 2 }, { customer: 'cus_fixture', status: 'trialing', limit: 2 }]);
});
test('subscription edge: unknown product returns a reconciliation error, never Premium', async () => {
  fixture.subscriptions = [{ status: 'active', current_period_end: end, items: { data: [{ price: { product: 'prod_unknown' }, current_period_end: end }] } }];
  const response = await handler(request()); const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.code, 'SUBSCRIPTION_RECONCILIATION_REQUIRED');
  assert.equal(body.plan_type, undefined);
});
test('subscription edge: duplicate active subscriptions remain visible to reconciliation', async () => {
  fixture.subscriptions = [subscription, subscription];
  const response = await handler(request());
  assert.equal(response.status, 409);
});
test('subscription edge: no paid subscription returns free', async () => {
  fixture.subscriptions = [];
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).subscribed, false);
});
test('subscription edge: paginated subscription items require reconciliation', async () => {
  fixture.subscriptions = [{ ...subscription, items: { ...subscription.items, has_more: true } }];
  assert.equal((await handler(request())).status, 409);
});
test('subscription edge: multiple customer records cannot be reduced to the first', async () => {
  fixture.customers = [{ id: 'cus_fixture', metadata: { user_id: 'fixture-user' } }, { id: 'cus_duplicate', metadata: { user_id: 'fixture-user' } }]; fixture.subscriptions = [subscription];
  try { assert.equal((await handler(request())).status, 409); }
  finally { fixture.customers = [{ id: 'cus_fixture', metadata: { user_id: 'fixture-user' } }]; }
});
test('subscription edge: paginated customer records require reconciliation', async () => {
  fixture.customersHasMore = true; fixture.subscriptions = [subscription];
  try { assert.equal((await handler(request())).status, 409); }
  finally { fixture.customersHasMore = false; }
});
test('subscription edge: no customer does not grant paid rights', async () => {
  fixture.customers = []; fixture.subscriptions = [];
  try {
    const response = await handler(request());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).subscribed, false);
  } finally { fixture.customers = [{ id: 'cus_fixture', metadata: { user_id: 'fixture-user' } }]; }
});

for (const status of ['active', 'trialing']) {
  test(`subscription edge: paginated ${status} subscription pages cannot grant a paid entitlement`, async () => {
    fixture.subscriptions = [{ ...subscription, status }];
    fixture.subscriptionsHasMore[status] = true;
    try {
      const response = await handler(request()); const body = await response.json();
      assert.equal(response.status, 409);
      assert.equal(body.code, 'SUBSCRIPTION_RECONCILIATION_REQUIRED');
      assert.equal(body.subscribed, undefined);
      assert.equal(body.plan_type, undefined);
    } finally { fixture.subscriptionsHasMore[status] = false; }
  });
}

const ownershipCases: Record<string, string>[] = [{ user_id: 'another-user' }, {}];
for (const metadata of ownershipCases) {
  test(`subscription ownership: email candidate ${metadata.user_id ? 'owned by another user' : 'without ownership'} is refused`, async () => {
    fixture.customers = [{ id: 'cus_other', metadata }];
    fixture.subscriptions = [subscription];
    const response = await handler(request());
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, 'customer_reconciliation_required');
    assert.equal(body.subscribed, undefined);
    assert.deepEqual(fixture.calls, []);
  });
}

test('subscription ownership: a stored owner binding survives an email change and absent provider metadata', async () => {
  fixture.rows = [{ user_id: 'fixture-user', plan_type: 'pro', status: 'active', stripe_customer_id: 'cus_fixture' }];
  fixture.retrievedCustomer = { id: 'cus_fixture', metadata: {} };
  fixture.customers = [{ id: 'cus_foreign', metadata: { user_id: 'another-user' } }];
  fixture.subscriptions = [subscription];
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).plan_type, 'pro');
  assert.deepEqual(fixture.customerLists, []);
  assert.deepEqual(fixture.customerRetrievals, ['cus_fixture']);
  assert.deepEqual(fixture.calls.map(call => call.customer), ['cus_fixture', 'cus_fixture']);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('subscription ownership: deleted, mismatched or foreign bound customer is refused', async () => {
  const invalidCustomers = [
    { id: 'cus_fixture', deleted: true as const },
    { id: 'cus_other', metadata: { user_id: 'fixture-user' } },
    { id: 'cus_fixture', metadata: { user_id: 'another-user' } },
  ];
  for (const customer of invalidCustomers) {
    resetFixture();
    fixture.rows = [{ user_id: 'fixture-user', plan_type: 'pro', status: 'active', stripe_customer_id: 'cus_fixture' }];
    fixture.retrievedCustomer = customer;
    fixture.subscriptions = [subscription];
    assert.equal((await handler(request())).status, 409);
    assert.deepEqual(fixture.calls, []);
    assert.deepEqual(fixture.customerCreations, []);
  }
});

test('subscription ownership: conflicting or duplicate local customer bindings are refused', async () => {
  for (const owners of [['another-user'], ['fixture-user', 'another-user'], ['fixture-user', 'fixture-user']]) {
    resetFixture();
    fixture.rows = owners.map(user_id => ({ user_id, plan_type: 'pro', status: 'active', stripe_customer_id: 'cus_fixture' }));
    fixture.subscriptions = [subscription];
    const response = await handler(request());
    assert.equal(response.status, owners[0] === owners[1] ? 503 : 409);
    assert.deepEqual(fixture.calls, []);
    assert.deepEqual(fixture.customerCreations, []);
  }
});

test('subscription ownership: database lookup errors cannot become a free or paid success', async () => {
  for (const error of ['rowError', 'bindingError'] as const) {
    resetFixture();
    fixture[error] = true;
    fixture.subscriptions = [subscription];
    const response = await handler(request());
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private database|fixture-user|fixture@example/);
    assert.deepEqual(fixture.calls, []);
    if (error === 'rowError') {
      assert.deepEqual(fixture.customerLists, []);
      assert.deepEqual(fixture.customerRetrievals, []);
    }
    assert.deepEqual(fixture.customerCreations, []);
  }
});

test('subscription ownership: no customer preserves the complete free response without a creation', async () => {
  fixture.customers = [];
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { subscribed: false, plan_type: 'free', product_id: null, subscription_end: null });
  assert.deepEqual(fixture.calls, []);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('subscription admission: POST and OPTIONS only; malformed bearer tokens never reach authentication', async () => {
  assert.equal((await handler(new Request('https://fixture.invalid', { method: 'OPTIONS' }))).status, 200);
  assert.equal((await handler(new Request('https://fixture.invalid', { method: 'GET', headers: { Authorization: 'Bearer fixture' } }))).status, 405);
  for (const authorization of ['', 'fixture', 'Basic fixture', 'Bearer one two', 'Bearer']) {
    assert.equal((await handler(new Request('https://fixture.invalid', { method: 'POST', headers: { Authorization: authorization } }))).status, 401);
  }
  assert.equal(fixture.clientsCreated, 0);
  assert.deepEqual(fixture.authCalls, []);
  assert.deepEqual(fixture.customerLists, []);
  assert.deepEqual(fixture.calls, []);
});

test('subscription admission: absent or revoked authenticated identity cannot read billing data', async () => {
  for (const rejected of ['absent', 'revoked']) {
    resetFixture();
    if (rejected === 'absent') fixture.authUser = null;
    else fixture.authError = true;
    const response = await handler(request());
    assert.equal(response.status, 401);
    assert.doesNotMatch(await response.text(), /private authentication|fixture-user|fixture@example/);
    assert.deepEqual(fixture.databaseReads, []);
    assert.deepEqual(fixture.customerLists, []);
    assert.deepEqual(fixture.calls, []);
  }
});

test('subscription admission: request identity fields cannot change the authenticated owner', async () => {
  fixture.subscriptions = [subscription];
  const response = await handler(new Request('https://fixture.invalid/subscription', {
    method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: 'another-user', customer: 'cus_other', email: 'other@example.invalid' }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(fixture.databaseReads[0], { column: 'user_id', value: 'fixture-user' });
  assert.deepEqual(fixture.customerLists, [{ email: 'fixture@example.invalid', limit: 100 }]);
  assert.deepEqual(fixture.calls.map(call => call.customer), ['cus_fixture', 'cus_fixture']);
});

test('subscription privacy: provider errors return and log only generic details', async () => {
  for (const error of ['customerError', 'subscriptionError'] as const) {
    resetFixture();
    fixture[error] = 'private-provider-secret customer@example.invalid';
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    let response: Response;
    try { response = await handler(request()); }
    finally { console.error = original; }
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      error: 'La facturation est momentanément indisponible. Réessaie dans un instant.',
      code: 'provider_unavailable',
    });
    assert.deepEqual(errors, [['[BILLING]', 'provider_unavailable']]);
    assert.deepEqual(fixture.customerCreations, []);
  }
});
