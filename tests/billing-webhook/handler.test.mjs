import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from '../billing/test-case.mjs';
import { createFixture, subscriptionRow, userId, otherUserId } from './fixture.mjs';

const source = process.env.PURAMA_WEBHOOK_TEST_SOURCE ? readFileSync(process.env.PURAMA_WEBHOOK_TEST_SOURCE, 'utf8') : undefined;
const fixture = () => createFixture({ source });
const session = state => state.event.data.object;
const subscriptionWrites = state => state.mutations.filter(value => value.table === 'subscriptions');
const activations = state => subscriptionWrites(state).filter(value => Object.keys(value.values).some(key => key !== 'updated_at'));
const confirmations = state => subscriptionWrites(state).filter(value => Object.keys(value.values).length === 1 && Object.hasOwn(value.values, 'updated_at'));
// Rejected inputs must still perform no write, including a version-only touch.
const assertNoRights = state => assert.equal(subscriptionWrites(state).length, 0);

test('an unknown Stripe key prefix is a configuration failure before every effect', async () => {
  const { state, env, deliver } = fixture();
  env.STRIPE_SECRET_KEY = 'opaque_inert_key';
  const response = await deliver();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Server configuration error' });
  assert.deepEqual(state.calls, []);
  assert.equal(state.observations.size, 0);
  assert.equal(state.mutations.length, 0);
  assert.equal(state.credits.size, 0);
});

for (const key of ['sk_test_inert', 'rk_test_inert', 'sk_live_inert', 'rk_live_inert']) {
  test(`${key}: supported secret and restricted key modes retain their explicit mode guard`, async () => {
    const { state, env, deliver } = fixture();
    env.STRIPE_SECRET_KEY = key;
    const live = key.includes('_live_');
    state.event.livemode = live;
    session(state).livemode = live;
    state.subscription.livemode = live;
    state.customer.livemode = live;
    assert.equal((await deliver()).status, 200);
    assert.equal(activations(state).length, 1);
    assert.equal(state.observations.size, 1);
    const mismatched = fixture();
    mismatched.env.STRIPE_SECRET_KEY = key;
    mismatched.state.event.livemode = !live;
    const deferred = await mismatched.deliver();
    assert.equal(deferred.status, 200);
    assert.equal((await deferred.json()).reason, 'provider_mode_mismatch');
    assert.equal(mismatched.state.mutations.length, 0);
    assert.equal(mismatched.state.credits.size, 0);
    assert.ok(mismatched.state.calls.every(call => ['verifySignature', 'rpc'].includes(call.kind)));
  });
}

test('signed server identity creates and confirms a missing subscription, without auth email pagination', async () => {
  const { state, deliver } = fixture();
  const response = await deliver();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true, event_id: state.event.id, duplicate: false, reconciliation: 'required' });
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
  assert.equal(confirmations(state).length, 1);
  assert.equal(state.tables.subscriptions[0].revision, 1);
});

test('referral observations never create annualized rights when entitlement is already applied', async () => {
  const { state, deliver } = fixture();
  state.tables.subscriptions = [subscriptionRow({ stripe_customer_id: 'cus_fixture', stripe_subscription_id: 'sub_fixture', plan_type: 'pro' })];
  session(state).metadata.influencer_id = 'influencer_fixture';
  session(state).metadata.referral_code = 'FIXTURE';
  state.tables.influencers = [{ id: 'influencer_fixture', user_id: otherUserId, commission_rate: 10, total_revenue: 0, total_sales: 0 }];
  assert.equal((await deliver()).status, 200);
  assert.equal(activations(state).length, 0);
  assert.equal(confirmations(state).length, 1);
  assert.equal(state.tables.commissions.length, 0);
  assert.equal(state.tables.influencers[0].total_sales, 0);
  assert.equal(state.tables.notifications.length, 0);
  assert.equal(state.observations.size, 1);
});

for (const scenario of ['paid-monthly', 'full-discount', 'provider-trial']) {
  test(`${scenario}: repeated checkout records facts without commissions, sales counters or gain notifications`, async () => {
    const { state, deliver } = fixture();
    Object.assign(session(state).metadata, { influencer_id: 'influencer_fixture', referral_code: 'FIXTURE' });
    session(state).amount_total = scenario === 'paid-monthly' ? 9900 : 0;
    session(state).payment_status = scenario === 'paid-monthly' ? 'paid' : 'no_payment_required';
    state.invoice.amount_paid = session(state).amount_total;
    if (scenario === 'provider-trial') {
      state.subscription.status = 'trialing';
      state.subscription.trial_start = Math.floor(Date.now() / 1000);
      state.subscription.trial_end = state.subscription.trial_start + 86400;
      state.subscription.latest_invoice = null;
    }
    state.tables.influencers = [{ id: 'influencer_fixture', user_id: otherUserId, commission_rate: 10, total_revenue: 0, total_sales: 0 }];
    assert.equal((await deliver()).status, 200);
    const replay = await deliver();
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).duplicate, true);
    assert.equal(activations(state).length, 1);
    assert.equal(confirmations(state).length, 1);
    assert.equal(state.observations.size, 1);
    assert.equal(state.tables.commissions.length, 0);
    assert.equal(state.tables.influencers[0].total_sales, 0);
    assert.equal(state.tables.influencers[0].total_revenue, 0);
    assert.equal(state.tables.notifications.length, 0);
  });
}

for (const [label, failure] of [
  ['database failure', { error: { message: 'private journal failure' } }],
  ['missing durable receipt', { data: null }],
  ['wrong durable receipt', { data: { recorded: true, event_id: 'evt_other', duplicate: false, reconciliation: 'required' } }],
]) {
  test(`journal ${label} stops all provider and entitlement effects`, async () => {
    const { state, deliver } = fixture();
    state.journalFailures.push(failure);
    const response = await deliver();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Webhook processing failed; event not acknowledged' });
    assert.equal(state.observations.size, 0);
    assertNoRights(state);
    assert.ok(state.calls.every(call => ['verifySignature', 'rpc'].includes(call.kind)));
  });
}

test('lost journal receipt retries the retained event and applies the entitlement only once', async () => {
  const { state, deliver } = fixture();
  state.journalFailures.push({ afterWrite: true, data: null });
  assert.equal((await deliver()).status, 503);
  assert.equal(state.observations.size, 1);
  assertNoRights(state);
  assert.equal((await deliver()).status, 200);
  assert.equal((await deliver()).status, 200);
  assert.equal(activations(state).length, 1);
  assert.equal(state.observations.size, 1);
});

test('conflicting event replay cannot replace its evidence or repeat entitlement effects', async () => {
  const { state, deliver } = fixture();
  assert.equal((await deliver()).status, 200);
  const evidence = JSON.stringify([...state.observations.values()]);
  session(state).amount_total = 1;
  assert.equal((await deliver()).status, 503);
  assert.equal(JSON.stringify([...state.observations.values()]), evidence);
  assert.equal(activations(state).length, 1);
});

for (const mode of ['connected-account', 'wrong-mode']) {
  test(`${mode}: retain evidence and defer all platform entitlement effects`, async () => {
    const { state, deliver } = fixture();
    if (mode === 'connected-account') state.event.account = 'acct_other';
    else state.event.livemode = true;
    const response = await deliver();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).application, 'deferred');
    assert.equal(state.observations.size, 1);
    assertNoRights(state);
    assert.ok(state.calls.every(call => ['verifySignature', 'rpc'].includes(call.kind)));
  });
}

test('an old canceled subscription cannot downgrade a different open subscription of the same customer', async () => {
  const { state, deliver } = fixture();
  state.subscription.status = 'canceled';
  state.subscriptionList = [state.subscription, { ...state.subscription, id: 'sub_replacement', status: 'active' }];
  state.tables.subscriptions = [subscriptionRow({ id: 'subscription_row', stripe_customer_id: 'cus_fixture', plan_type: 'pro' })];
  state.event.type = 'customer.subscription.deleted';
  state.event.data.object = state.subscription;
  assert.equal((await deliver()).status, 503);
  assert.equal(state.observations.size, 1);
  assertNoRights(state);
  assert.equal(state.tables.subscriptions[0].plan_type, 'pro');
});

test('a failed invoice without a subscription reference is journaled without downgrading rights', async () => {
  const { state, deliver } = fixture();
  state.tables.subscriptions = [subscriptionRow({ stripe_customer_id: 'cus_fixture', plan_type: 'pro' })];
  state.event.type = 'invoice.payment_failed';
  state.event.data.object = { ...state.invoice, object: 'invoice', status: 'open' };
  assert.equal((await deliver()).status, 200);
  assert.equal(state.observations.size, 1);
  assertNoRights(state);
  assert.equal(state.calls.filter(call => call.kind === 'retrieveSubscription').length, 0);
  assert.equal(state.tables.subscriptions[0].status, 'active');
});

test('concurrent first deliveries create only one entitlement; a failed contender is retryable', async () => {
  const { state, deliver } = fixture();
  const responses = await Promise.all([deliver(), deliver()]);
  assert.ok(responses.every(response => [200, 503].includes(response.status)));
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
    assert.equal((await deliver()).status, 503);
    assertNoRights(state);
    assert.equal((await deliver()).status, 200);
    assert.equal((await deliver()).status, 200);
    assert.equal(activations(state).length, 1);
  });
  test(`${action} without a returned row is not acknowledged as a confirmed write`, async () => {
    const { state, deliver } = fixture();
    if (action === 'update') state.tables.subscriptions = [subscriptionRow()];
    state.failures.push({ table: 'subscriptions', action, data: [] });
    assert.equal((await deliver()).status, 503);
    assertNoRights(state);
  });
}

test('lost database receipt returns failure; redelivery observes the committed row without duplicating it', async () => {
  const { state, deliver } = fixture();
  state.failures.push({ table: 'subscriptions', action: 'insert', afterWrite: true, data: [] });
  assert.equal((await deliver()).status, 503);
  assert.equal((await deliver()).status, 200);
  assert.equal(activations(state).length, 1);
});

test('a contradictory write receipt cannot acknowledge the intended entitlement', async () => {
  const { state, deliver } = fixture();
  state.failures.push({ table: 'subscriptions', action: 'insert', data: [subscriptionRow({ user_id: otherUserId, stripe_customer_id: 'cus_fixture', plan_type: 'pro' })] });
  assert.equal((await deliver()).status, 503);
  assertNoRights(state);
});

test('a concurrent local trial invalidates the paid write and its consumed flag survives retry', async () => {
  const { state, deliver } = fixture();
  state.tables.subscriptions = [subscriptionRow()];
  state.beforeQuery = spec => {
    if (spec.table === 'subscriptions' && spec.action === 'update') {
      Object.assign(state.tables.subscriptions[0], {
        has_used_trial: true, status: 'trialing', trial_ends_at: '2027-01-15T00:00:00.000Z',
        stripe_subscription_id: null, revision: state.tables.subscriptions[0].revision + 1,
      });
      state.beforeQuery = null;
    }
  };
  assert.equal((await deliver()).status, 503);
  assertNoRights(state);
  assert.equal((await deliver()).status, 200);
  assert.equal(state.tables.subscriptions[0].has_used_trial, true);
  assert.equal(state.tables.subscriptions[0].trial_ends_at, '2027-01-15T00:00:00.000Z');
  assert.equal(activations(state)[0].values.has_used_trial, true);
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
  ['event and session mode contradict', state => { session(state).livemode = true; }],
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
    assert.equal((await deliver()).status, 503);
    assertNoRights(state);
    assert.equal(state.tables.commissions.length, 0);
  });
}

for (const status of ['incomplete', 'incomplete_expired', 'unpaid', 'past_due', 'paused', 'canceled']) {
  test(`provider status ${status} never becomes active`, async () => {
    const { state, deliver } = fixture();
    state.subscription.status = status;
    assert.equal((await deliver()).status, 503);
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
  assert.equal((await deliver()).status, 503);
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

test('PostgREST timezone serialization confirms a trial write and permits replay without granting rights again', async () => {
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
    assert.equal((await deliver()).status, 503);
    assertNoRights(state);
  }
});

test('fully discounted active subscription remains supported', async () => {
  const { state, deliver } = fixture();
  session(state).payment_status = 'no_payment_required';
  assert.equal((await deliver()).status, 200);
  assert.equal(state.tables.subscriptions[0].status, 'active');
  assert.deepEqual(state.calls.filter(call => call.kind === 'retrieveInvoice'), [{ kind: 'retrieveInvoice', id: 'in_fixture' }]);
});

for (const paymentStatus of ['paid', 'no_payment_required']) {
  for (const [label, configure] of [
    ['missing invoice', state => { state.subscription.latest_invoice = null; }],
    ['unpaid current invoice', state => { state.invoice.status = 'open'; }],
    ['different invoice identity', state => { state.invoice.id = 'in_other'; }],
    ['different invoice customer', state => { state.invoice.customer = 'cus_other'; }],
    ['deleted expanded invoice customer', state => { state.invoice.customer = { id: 'cus_fixture', deleted: true }; }],
    ['invoice provider failure', state => { state.invoiceError = new Error('inert invoice lookup failure'); }],
  ]) {
    test(`${paymentStatus}: active checkout rejects ${label} before any entitlement or commission`, async () => {
      const { state, deliver } = fixture();
      session(state).payment_status = paymentStatus;
      configure(state);
      assert.equal((await deliver()).status, 503);
      assertNoRights(state);
      assert.equal(state.tables.commissions.length, 0);
    });
  }
}

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
    assert.equal(state.calls.filter(call => call.kind === 'rpc' && call.name === 'credit_overage_pack').length, 2);
    assert.equal(state.calls.find(call => call.kind === 'rpc' && call.name === 'credit_overage_pack').parameters.p_actions, 2000);
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
  assert.equal((await deliver()).status, 503);
  assert.equal(state.calls.length, 0);
});

test('the VM blocks network calls and imports outside its provider allowlist', () => {
  assert.throws(() => createFixture({ source: "fetch('https://example.invalid')" }), /Network access is forbidden/);
  assert.throws(() => createFixture({ source: "import 'node:https';" }), /Unapproved module import/);
});

// Ingress policy is tested through the actual handler, before its inert SDK
// boundary. These constants are acceptance limits, not imports from production.
const webhookBodyLimit = 1024 * 1024;
const bodyEncoder = new TextEncoder();
function bodyRequest(body, headers = {}, signal) {
  return new Request('https://webhook.example.invalid/', {
    method: 'POST', duplex: 'half', body, signal,
    headers: { 'content-type': 'application/json', 'stripe-signature': 'fixture_signature', ...headers },
  });
}
function sizedBody(event, bytes) {
  const payload = JSON.stringify(event);
  return payload + ' '.repeat(bytes - bodyEncoder.encode(payload).byteLength);
}
function chunkedBody(bytes, chunkSize = 16 * 1024, onCancel = () => {}) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.byteLength) return controller.close();
      const next = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, next));
      offset = next;
    },
    cancel: onCancel,
  }, { highWaterMark: 0 });
}
function assertNoBodyEffects(state) {
  assert.deepEqual(state.calls, [], 'No signature, provider, Auth or database call before body acceptance');
  assert.equal(state.observations.size, 0);
  assert.equal(state.mutations.length, 0);
  assert.equal(state.credits.size, 0);
}
function bodyClock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  const delays = [];
  return {
    delays,
    now: () => now,
    setTimeout: (callback, delay) => {
      delays.push(delay);
      const id = ++sequence;
      timers.set(id, { callback, deadline: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    advance(milliseconds, fire = true) {
      now += milliseconds;
      if (fire) for (const [id, timer] of timers) {
        if (timer.deadline <= now) { timers.delete(id); timer.callback(); }
      }
    },
    pending: () => timers.size,
  };
}

test('webhook body: chunked UTF-8, whitespace and CRLF reach signature verification unchanged', async () => {
  const { state, deliverRequest } = fixture();
  state.event.data.object.description = 'é e\u0301 € 🌍';
  const payload = ` \r\n${JSON.stringify(state.event, null, 2).replaceAll('\n', '\r\n')}\t\r\n`;
  const response = await deliverRequest(bodyRequest(chunkedBody(bodyEncoder.encode(payload), 1)));
  assert.equal(response.status, 200);
  assert.deepEqual(state.signatureBodies, [payload]);
  assert.equal(state.observations.size, 1);
  assert.equal(activations(state).length, 1);
});

test('webhook body: a BOM is preserved for the SDK instead of silently changing the signed bytes', async () => {
  const { state, deliverRequest } = fixture();
  const payload = '\uFEFF' + JSON.stringify(state.event);
  const response = await deliverRequest(bodyRequest(chunkedBody(bodyEncoder.encode(payload), 1)));
  // The SDK boundary parses JSON only after seeing the exact original text.
  assert.equal(response.status, 400);
  assert.deepEqual(state.signatureBodies, [payload]);
  assert.deepEqual(state.calls, [{ kind: 'verifySignature' }]);
  assert.equal(state.observations.size, 0);
  assert.equal(state.mutations.length, 0);
});

for (const declared of [false, true]) {
  test(`webhook body: exactly 1 MiB is accepted with Content-Length ${declared ? 'present' : 'absent'}`, async () => {
    const { state, deliverRequest } = fixture();
    const payload = sizedBody(state.event, webhookBodyLimit);
    const headers = declared ? { 'content-length': String(webhookBodyLimit) } : {};
    const response = await deliverRequest(bodyRequest(chunkedBody(bodyEncoder.encode(payload)), headers));
    assert.equal(response.status, 200);
    assert.deepEqual(state.signatureBodies, [payload]);
    assert.equal(state.observations.size, 1);
  });

  test(`webhook body: 1 MiB plus one streamed byte is rejected with Content-Length ${declared ? 'understated' : 'absent'}`, async () => {
    const { state, deliverRequest } = fixture();
    const payload = sizedBody(state.event, webhookBodyLimit + 1);
    let cancelled = false;
    const headers = declared ? { 'content-length': String(webhookBodyLimit) } : {};
    const response = await deliverRequest(bodyRequest(chunkedBody(bodyEncoder.encode(payload), 16 * 1024, () => { cancelled = true; }), headers));
    assert.equal(response.status, 413);
    assert.equal(cancelled, true);
    assertNoBodyEffects(state);
  });
}

test('webhook body: an excessive declared length refuses a stalled source without reading or waiting for cancellation', async () => {
  const { state, deliverRequest } = fixture();
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull() { pulls++; return new Promise(() => {}); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  }, { highWaterMark: 0 });
  const response = await deliverRequest(bodyRequest(body, { 'content-length': String(webhookBodyLimit + 1) }));
  assert.equal(response.status, 413);
  assert.equal(pulls, 0);
  assert.equal(cancelled, true);
  assertNoBodyEffects(state);
});

test('webhook body: an unbounded chunk source is cancelled at the byte budget', async () => {
  const { state, deliverRequest } = fixture();
  let pulls = 0;
  let cancelled = false;
  const chunk = bodyEncoder.encode(' '.repeat(64 * 1024));
  const body = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const response = await deliverRequest(bodyRequest(body));
  assert.equal(response.status, 413);
  assert.equal(pulls, 17, 'The source stops at the first chunk crossing 1 MiB');
  assert.equal(cancelled, true);
  assertNoBodyEffects(state);
});

for (const length of ['short', 'long', '-1', '2.5']) {
  test(`webhook body: false or malformed Content-Length (${length}) is rejected before verification`, async () => {
    const { state, deliverRequest } = fixture();
    const payload = JSON.stringify(state.event);
    const declared = length === 'short' ? '1' : length === 'long' ? String(bodyEncoder.encode(payload).byteLength + 1) : length;
    const response = await deliverRequest(bodyRequest(payload, { 'content-length': declared }));
    assert.equal(response.status, 400);
    assertNoBodyEffects(state);
  });
}

test('webhook body: invalid UTF-8 is refused before signature verification', async () => {
  const { state, deliverRequest } = fixture();
  const response = await deliverRequest(bodyRequest(chunkedBody(new Uint8Array([0xc3, 0x28]), 1)));
  assert.equal(response.status, 400);
  assertNoBodyEffects(state);
});

test('webhook body: a read failure is sanitized and never acknowledged', async () => {
  const { state, deliverRequest } = fixture();
  const body = new ReadableStream({ pull(controller) { controller.error(new Error('private_body_marker')); } });
  const response = await deliverRequest(bodyRequest(body));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Invalid request body' });
  assertNoBodyEffects(state);
});

test('webhook body: a pre-aborted request cancels its source before all effects', async () => {
  const { state, deliverRequest } = fixture();
  const abort = new AbortController();
  abort.abort();
  let cancelled = false;
  const body = chunkedBody(bodyEncoder.encode(JSON.stringify(state.event)), 1, () => { cancelled = true; });
  const response = await deliverRequest(bodyRequest(body, {}, abort.signal));
  assert.equal(response.status, 408);
  assert.equal(cancelled, true);
  assertNoBodyEffects(state);
});

test('webhook body: abort during a pending read does not wait for a hostile cancel promise', async () => {
  const { state, deliverRequest } = fixture();
  const abort = new AbortController();
  let started;
  const reading = new Promise(resolve => { started = resolve; });
  let cancelled = false;
  const body = new ReadableStream({
    pull() { started(); return new Promise(() => {}); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  }, { highWaterMark: 0 });
  const pending = deliverRequest(bodyRequest(body, {}, abort.signal));
  await reading;
  abort.abort();
  assert.equal((await pending).status, 408);
  assert.equal(cancelled, true);
  assertNoBodyEffects(state);
});

test('webhook body: the 5-second deadline bounds a pending read and hostile cancellation', async () => {
  const clock = bodyClock();
  const { state, deliverRequest } = createFixture({ source, clock });
  let started;
  const reading = new Promise(resolve => { started = resolve; });
  let cancelled = false;
  const body = new ReadableStream({
    pull() { started(); return new Promise(() => {}); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  }, { highWaterMark: 0 });
  let settled = false;
  const pending = deliverRequest(bodyRequest(body)).then(response => { settled = true; return response; });
  await reading;
  assert.deepEqual(clock.delays, [5000]);
  clock.advance(4999);
  await Promise.resolve();
  assert.equal(settled, false);
  clock.advance(1);
  assert.equal((await pending).status, 408);
  assert.equal(cancelled, true);
  assert.equal(clock.pending(), 0);
  assertNoBodyEffects(state);
});

test('webhook body: continuing chunks cannot reset or starve the absolute read deadline', async () => {
  const clock = bodyClock();
  const { state, deliverRequest } = createFixture({ source, clock });
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      clock.advance(1000, false); // Progress without letting the timer callback run.
      controller.enqueue(new Uint8Array([32]));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const response = await deliverRequest(bodyRequest(body));
  assert.equal(response.status, 408);
  assert.equal(pulls, 5);
  assert.equal(cancelled, true);
  assert.equal(clock.pending(), 0);
  assertNoBodyEffects(state);
});
