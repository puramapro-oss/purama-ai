import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createFixture, subscriptionRow, userId, otherUserId } from './fixture.mjs';

const source = process.env.PURAMA_WEBHOOK_TEST_SOURCE ? readFileSync(process.env.PURAMA_WEBHOOK_TEST_SOURCE, 'utf8') : undefined;
const fixture = () => createFixture({ source });
const session = state => state.event.data.object;
const activations = state => state.mutations.filter(value => value.table === 'subscriptions');
const assertNoRights = state => assert.equal(activations(state).length, 0);

test('signed server identity creates and confirms a missing subscription, without auth email pagination', async () => {
  const { state, deliver } = fixture();
  const response = await deliver();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true });
  assert.equal(state.tables.subscriptions.length, 1);
  assert.deepEqual(state.tables.subscriptions.map(row => [row.user_id, row.plan_type, row.status, row.stripe_customer_id]), [[userId, 'pro', 'active', 'cus_fixture']]);
  assert.deepEqual(state.calls.filter(call => call.kind === 'getUserById'), [{ kind: 'getUserById', id: userId }]);
  assert.equal(activations(state).length, 1);
});

test('paid conversion preserves an already consumed local trial', async () => {
  const { state, deliver } = fixture();
  const end = '2026-01-15T00:00:00.000Z';
  state.tables.subscriptions = [subscriptionRow({ status: 'trialing', plan_type: 'ultime', has_used_trial: true, trial_ends_at: end })];
  assert.equal((await deliver()).status, 200);
  assert.equal(state.tables.subscriptions[0].has_used_trial, true);
  assert.equal(state.tables.subscriptions[0].trial_ends_at, end);
  assert.equal(state.tables.subscriptions[0].status, 'active');
});

test('sequential redelivery does not repeat entitlement activation', async () => {
  const { state, deliver } = fixture();
  assert.equal((await deliver()).status, 200);
  assert.equal((await deliver()).status, 200);
  assert.equal(activations(state).length, 1);
});

test('a first referral still processes when a subscription event already applied the entitlement', async () => {
  const { state, deliver } = fixture();
  state.tables.subscriptions = [subscriptionRow({ stripe_customer_id: 'cus_fixture', plan_type: 'pro' })];
  session(state).metadata.influencer_id = 'influencer_fixture';
  session(state).metadata.referral_code = 'FIXTURE';
  state.tables.influencers = [{ id: 'influencer_fixture', user_id: otherUserId, commission_rate: 10, total_revenue: 0, total_sales: 0 }];
  assert.equal((await deliver()).status, 200);
  assertNoRights(state);
  assert.equal(state.tables.commissions.length, 1);
  assert.equal(state.tables.commissions[0].sale_amount, 99 * 12);
  assert.equal(state.tables.commissions[0].commission_amount, 99 * 12 * 0.1);
  assert.equal(state.tables.influencers[0].total_sales, 1);
  assert.equal(state.tables.notifications.length, 1);
});

test('concurrent first deliveries create only one entitlement; a failed contender is retryable', async () => {
  const { state, deliver } = fixture();
  const responses = await Promise.all([deliver(), deliver()]);
  assert.ok(responses.every(response => [200, 500].includes(response.status)));
  assert.ok(responses.some(response => response.status === 200));
  assert.equal((await deliver()).status, 200);
  assert.equal(state.tables.subscriptions.length, 1);
  assert.equal(activations(state).length, 1);
});

test('concurrent conversion uses a conditional update, then safely accepts retry', async () => {
  const { state, deliver } = fixture();
  state.tables.subscriptions = [subscriptionRow({ has_used_trial: true })];
  const responses = await Promise.all([deliver(), deliver()]);
  assert.ok(responses.some(response => response.status === 200));
  assert.equal((await deliver()).status, 200);
  assert.equal(activations(state).length, 1);
  assert.equal(state.tables.subscriptions[0].has_used_trial, true);
});

for (const action of ['insert', 'update']) {
  test(`${action} database failure is not acknowledged and retry completes only once`, async () => {
    const { state, deliver } = fixture();
    if (action === 'update') state.tables.subscriptions = [subscriptionRow()];
    state.failures.push({ table: 'subscriptions', action, error: { message: 'fixture unavailable' } });
    assert.equal((await deliver()).status, 500);
    assertNoRights(state);
    assert.equal((await deliver()).status, 200);
    assert.equal((await deliver()).status, 200);
    assert.equal(activations(state).length, 1);
  });
  test(`${action} without a returned row is not acknowledged as a confirmed write`, async () => {
    const { state, deliver } = fixture();
    if (action === 'update') state.tables.subscriptions = [subscriptionRow()];
    state.failures.push({ table: 'subscriptions', action, data: [] });
    assert.equal((await deliver()).status, 500);
    assertNoRights(state);
  });
}

test('lost database receipt returns failure; redelivery observes the committed row without duplicating it', async () => {
  const { state, deliver } = fixture();
  state.failures.push({ table: 'subscriptions', action: 'insert', afterWrite: true, data: [] });
  assert.equal((await deliver()).status, 500);
  assert.equal((await deliver()).status, 200);
  assert.equal(activations(state).length, 1);
});

test('a contradictory write receipt cannot acknowledge the intended entitlement', async () => {
  const { state, deliver } = fixture();
  state.failures.push({ table: 'subscriptions', action: 'insert', data: [subscriptionRow({ user_id: otherUserId, stripe_customer_id: 'cus_fixture', plan_type: 'pro' })] });
  assert.equal((await deliver()).status, 500);
  assertNoRights(state);
});

test('a concurrent consumed trial flag is never reset by paid activation', async () => {
  const { state, deliver } = fixture();
  state.tables.subscriptions = [subscriptionRow()];
  state.beforeQuery = spec => {
    if (spec.table === 'subscriptions' && spec.action === 'update') state.tables.subscriptions[0].has_used_trial = true;
  };
  assert.equal((await deliver()).status, 200);
  assert.equal(state.tables.subscriptions[0].has_used_trial, true);
  assert.equal(Object.hasOwn(activations(state)[0].values, 'has_used_trial'), false);
});

test('legacy session may use only an existing, unique customer binding', async () => {
  const { state, deliver } = fixture();
  session(state).metadata = {};
  session(state).client_reference_id = null;
  state.subscription.metadata = {};
  state.customer.metadata = {};
  state.tables.subscriptions = [subscriptionRow({ stripe_customer_id: 'cus_fixture', has_used_trial: true })];
  assert.equal((await deliver()).status, 200);
  assert.equal(state.tables.subscriptions[0].user_id, userId);
  assert.equal(state.tables.subscriptions[0].has_used_trial, true);
});

const invalidCases = [
  ['missing server identity and no legacy binding', state => { session(state).metadata = {}; session(state).client_reference_id = null; }],
  ['malformed server identity', state => { session(state).metadata.user_id = 'not-a-user'; }],
  ['subscription metadata contradicts session', state => { state.subscription.metadata.user_id = otherUserId; }],
  ['customer metadata contradicts session', state => { state.customer.metadata.user_id = otherUserId; }],
  ['client reference contradicts session', state => { session(state).client_reference_id = otherUserId; }],
  ['unbound customer without server ownership metadata', state => { state.customer.metadata = {}; }],
  ['database customer belongs to another user', state => { state.tables.subscriptions = [subscriptionRow({ user_id: otherUserId, stripe_customer_id: 'cus_fixture' })]; }],
  ['user is already bound to another customer', state => { state.tables.subscriptions = [subscriptionRow({ stripe_customer_id: 'cus_other' })]; }],
  ['customer has ambiguous database owners', state => { state.tables.subscriptions = [subscriptionRow({ stripe_customer_id: 'cus_fixture' }), subscriptionRow({ user_id: otherUserId, stripe_customer_id: 'cus_fixture' })]; }],
  ['user has ambiguous database rows', state => { state.tables.subscriptions = [subscriptionRow(), subscriptionRow()]; }],
  ['auth lookup returns no user', state => { state.users = []; }],
  ['auth lookup fails', state => { state.authError = { message: 'fixture unavailable' }; }],
  ['database lookup fails', state => { state.failures.push({ table: 'subscriptions', action: 'select', error: { message: 'fixture unavailable' } }); }],
  ['retrieved subscription id differs', state => { state.subscription.id = 'sub_other'; }],
  ['subscription belongs to another customer', state => { state.subscription.customer = 'cus_other'; }],
  ['retrieved customer id differs', state => { state.customer.id = 'cus_other'; }],
  ['deleted customer', state => { state.customer = { id: 'cus_fixture', deleted: true }; }],
  ['test/live identity conflict', state => { state.subscription.livemode = true; }],
  ['event and session mode contradict', state => { state.event.livemode = true; }],
  ['unknown product cannot become pro', state => { state.subscription.items.data[0].price.product = 'prod_unknown'; }],
  ['deleted expanded product', state => { state.subscription.items.data[0].price.product = { id: 'prod_UHwPSU2o4DW6Ej', deleted: true }; }],
  ['multiple line items', state => { state.subscription.items.data.push({ price: { product: 'prod_unknown' } }); }],
  ['paginated line items', state => { state.subscription.items.has_more = true; }],
  ['missing line item pagination evidence', state => { delete state.subscription.items.has_more; }],
  ['multiple open subscriptions', state => { state.subscriptionList = [state.subscription, { ...state.subscription, id: 'sub_other' }]; }],
  ['paginated subscription list', state => { state.subscriptionsHasMore = true; }],
  ['missing checkout subscription', state => { session(state).subscription = null; }],
  ['missing checkout identity', state => { delete session(state).id; }],
  ['checkout is not complete', state => { session(state).status = 'open'; }],
];
for (const [label, configure] of invalidCases) {
  test(`rejects ${label} before granting rights`, async () => {
    const { state, deliver } = fixture();
    configure(state);
    assert.equal((await deliver()).status, 500);
    assertNoRights(state);
    assert.equal(state.tables.commissions.length, 0);
  });
}

for (const status of ['incomplete', 'incomplete_expired', 'unpaid', 'past_due', 'paused', 'canceled']) {
  test(`provider status ${status} never becomes active`, async () => {
    const { state, deliver } = fixture();
    state.subscription.status = status;
    assert.equal((await deliver()).status, 500);
    assertNoRights(state);
  });
}

test('unpaid checkout waits without activation; signed delayed payment success activates once', async () => {
  const { state, deliver } = fixture();
  session(state).payment_status = 'unpaid';
  state.subscription.status = 'incomplete';
  assert.equal((await deliver()).status, 200);
  assertNoRights(state);
  state.event.type = 'checkout.session.async_payment_succeeded';
  state.event.id = 'evt_paid';
  session(state).payment_status = 'paid';
  state.subscription.status = 'active';
  assert.equal((await deliver()).status, 200);
  assert.equal((await deliver()).status, 200);
  assert.equal(activations(state).length, 1);
});

test('an async success with unpaid evidence is rejected', async () => {
  const { state, deliver } = fixture();
  state.event.type = 'checkout.session.async_payment_succeeded';
  session(state).payment_status = 'unpaid';
  assert.equal((await deliver()).status, 500);
  assertNoRights(state);
});

test('unpaid checkout cannot activate even if the provider currently reports active', async () => {
  const { state, deliver } = fixture();
  session(state).payment_status = 'unpaid';
  assert.equal((await deliver()).status, 200);
  assertNoRights(state);
});

test('valid existing Stripe trial remains trialing and consumes the trial flag', async () => {
  const { state, deliver } = fixture();
  session(state).payment_status = 'no_payment_required';
  state.subscription.status = 'trialing';
  state.subscription.trial_start = 1800000000;
  state.subscription.trial_end = 4102444800;
  assert.equal((await deliver()).status, 200);
  assert.equal(state.tables.subscriptions[0].status, 'trialing');
  assert.equal(state.tables.subscriptions[0].has_used_trial, true);
  assert.equal(state.tables.subscriptions[0].trial_ends_at, '2100-01-01T00:00:00.000Z');
});

test('PostgREST timezone serialization confirms a trial write and permits replay without another write', async () => {
  const { state, deliver } = fixture();
  state.normalizeTimestamps = true;
  session(state).payment_status = 'no_payment_required';
  state.subscription.status = 'trialing';
  state.subscription.trial_end = 4102444800;
  assert.equal((await deliver()).status, 200);
  assert.equal(state.tables.subscriptions[0].trial_ends_at, '2100-01-01T00:00:00+00:00');
  assert.equal((await deliver()).status, 200);
  assert.equal(activations(state).length, 1);
});

test('expired or absent Stripe trial end cannot grant trial rights', async () => {
  for (const end of [null, 1, NaN]) {
    const { state, deliver } = fixture();
    session(state).payment_status = 'no_payment_required';
    state.subscription.status = 'trialing';
    state.subscription.trial_end = end;
    assert.equal((await deliver()).status, 500);
    assertNoRights(state);
  }
});

test('fully discounted active subscription remains supported', async () => {
  const { state, deliver } = fixture();
  session(state).payment_status = 'no_payment_required';
  assert.equal((await deliver()).status, 200);
  assert.equal(state.tables.subscriptions[0].status, 'active');
});

for (const [product, plan] of [['prod_UHwPcnEEVEDf4K', 'starter'], ['prod_UHwPSU2o4DW6Ej', 'pro'], ['prod_UHwPBOGTleT37J', 'ultime']]) {
  test(`preserves ${plan} product mapping and expanded provider identities`, async () => {
    const { state, deliver } = fixture();
    session(state).subscription = { id: 'sub_fixture' };
    session(state).customer = { id: 'cus_fixture' };
    state.subscription.customer = { id: 'cus_fixture' };
    state.subscription.items.data[0].price.product = { id: product };
    assert.equal((await deliver()).status, 200);
    assert.equal(state.tables.subscriptions[0].plan_type, plan);
  });
}

for (const type of ['checkout.session.completed', 'checkout.session.async_payment_succeeded']) {
  test(`${type} keeps the real overage receipt path and duplicate handling`, async () => {
    const { state, deliver } = fixture();
    state.event.type = type;
    Object.assign(session(state), { mode: 'payment', payment_intent: 'pi_fixture', amount_total: 2000, currency: 'eur', metadata: { type: 'overage_pack', user_id: userId } });
    assert.equal((await deliver()).status, 200);
    assert.equal((await deliver()).status, 200);
    assert.equal(state.credits.size, 1);
    assert.equal(state.calls.filter(call => call.kind === 'rpc').length, 2);
    assert.equal(state.calls.find(call => call.kind === 'rpc').parameters.p_actions, 2000);
    assertNoRights(state);
  });
}

for (const signature of [null, 'invalid']) {
  test(`signature ${signature ?? 'missing'} prevents provider or database effects`, async () => {
    const { state, deliver } = fixture();
    assert.equal((await deliver({ signature })).status, 400);
    assert.ok(state.calls.every(call => call.kind === 'verifySignature'));
    assertNoRights(state);
  });
}

test('missing webhook configuration fails before external effects', async () => {
  const { state, env, deliver } = fixture();
  delete env.STRIPE_WEBHOOK_SECRET;
  assert.equal((await deliver()).status, 500);
  assert.equal(state.calls.length, 0);
});

test('the VM blocks network calls and imports outside its provider allowlist', () => {
  assert.throws(() => createFixture({ source: "fetch('https://example.invalid')" }), /Network access is forbidden/);
  assert.throws(() => createFixture({ source: "import 'node:https';" }), /Unapproved module import/);
});
