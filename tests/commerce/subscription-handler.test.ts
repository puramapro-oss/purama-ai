import assert from 'node:assert/strict';
import { fixture } from './subscription-provider-fixture.ts';
import { getHandler } from './serve-capture.ts';
import '../../supabase/functions/check-subscription/index.ts';

Deno.env.set('STRIPE_SECRET_KEY', 'sk_test_fixture_only');
const handler = getHandler();
const end = 1_800_000_000;
const subscription = { status: 'active', items: { data: [{ price: { product: 'prod_UHwPSU2o4DW6Ej' }, current_period_end: end }] } };
const request = () => new Request('https://fixture.invalid/subscription', { method: 'POST', headers: { Authorization: 'Bearer fixture' } });

Deno.test('subscription edge: real handler accepts a Basil payload without top-level period', async () => {
  fixture.subscriptions = [subscription]; fixture.calls = [];
  const response = await handler(request()); const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, { subscribed: true, plan_type: 'pro', product_id: 'prod_UHwPSU2o4DW6Ej', subscription_end: new Date(end * 1000).toISOString() });
  assert.deepEqual(fixture.calls, [{ status: 'active', limit: 2 }, { status: 'trialing', limit: 2 }]);
});
Deno.test('subscription edge: unknown product returns a reconciliation error, never Premium', async () => {
  fixture.subscriptions = [{ status: 'active', current_period_end: end, items: { data: [{ price: { product: 'prod_unknown' }, current_period_end: end }] } }];
  const response = await handler(request()); const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.code, 'SUBSCRIPTION_RECONCILIATION_REQUIRED');
  assert.equal(body.plan_type, undefined);
});
Deno.test('subscription edge: duplicate active subscriptions remain visible to reconciliation', async () => {
  fixture.subscriptions = [subscription, subscription];
  const response = await handler(request());
  assert.equal(response.status, 409);
});
Deno.test('subscription edge: no paid subscription returns free', async () => {
  fixture.subscriptions = [];
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).subscribed, false);
});
Deno.test('subscription edge: paginated subscription items require reconciliation', async () => {
  fixture.subscriptions = [{ ...subscription, items: { ...subscription.items, has_more: true } }];
  assert.equal((await handler(request())).status, 409);
});
Deno.test('subscription edge: multiple customer records cannot be reduced to the first', async () => {
  fixture.customers = [{ id: 'cus_fixture' }, { id: 'cus_duplicate' }]; fixture.subscriptions = [subscription];
  try { assert.equal((await handler(request())).status, 409); }
  finally { fixture.customers = [{ id: 'cus_fixture' }]; }
});
Deno.test('subscription edge: paginated customer records require reconciliation', async () => {
  fixture.customersHasMore = true; fixture.subscriptions = [subscription];
  try { assert.equal((await handler(request())).status, 409); }
  finally { fixture.customersHasMore = false; }
});
Deno.test('subscription edge: no customer does not grant paid rights', async () => {
  fixture.customers = []; fixture.subscriptions = [];
  try {
    const response = await handler(request());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).subscribed, false);
  } finally { fixture.customers = [{ id: 'cus_fixture' }]; }
});

for (const status of ['active', 'trialing']) {
  Deno.test(`subscription edge: paginated ${status} subscription pages cannot grant a paid entitlement`, async () => {
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
