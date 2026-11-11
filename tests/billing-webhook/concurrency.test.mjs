import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from '../billing/test-case.mjs';
import { createFixture, subscriptionRow, userId } from './fixture.mjs';

const source = process.env.PURAMA_WEBHOOK_TEST_SOURCE ? readFileSync(process.env.PURAMA_WEBHOOK_TEST_SOURCE, 'utf8') : undefined;
const fixture = () => createFixture({ source });
const clone = value => structuredClone(value);

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Fixture barrier timed out: ${label}`)), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

function pauseFirstList(state) {
  const observed = deferred();
  const released = deferred();
  let paused = false;
  state.afterSubscriptionList = async page => {
    if (paused) return;
    paused = true;
    observed.resolve(clone(page));
    await bounded(released.promise, 'release first provider list');
  };
  return { observed: () => bounded(observed.promise, 'first provider observation'), release: released.resolve };
}

function cancellation(subscription, id = 'evt_cancel_old') {
  return { id, type: 'customer.subscription.deleted', livemode: false, created: 1800000020, data: { object: clone(subscription) } };
}

for (const sameState of [false, true]) {
  test(`old cancellation cannot overwrite a replacement checkout (${sameState ? 'same plan and status' : 'changed plan'})`, { timeout: 2500 }, async () => {
    const { state, deliver } = fixture();
    const replacement = clone(state.subscription);
    replacement.id = 'sub_replacement';
    const old = clone(state.subscription);
    old.id = 'sub_old';
    old.status = 'canceled';
    if (!sameState) old.items.data[0].price.product = 'prod_UHwPcnEEVEDf4K';
    state.tables.subscriptions = [subscriptionRow({
      id: '33333333-3333-4333-8333-333333333333', user_id: userId,
      stripe_customer_id: 'cus_fixture', stripe_subscription_id: old.id,
      revision: 0, plan_type: sameState ? 'pro' : 'starter', status: 'active',
    })];
    state.subscription = old;
    state.subscriptionList = [old];
    const barrier = pauseFirstList(state);
    const pendingCancellation = deliver({ event: cancellation(old) });
    let staleResponse;
    try {
      assert.deepEqual((await barrier.observed()).data.map(row => row.id), [old.id]);
      state.subscription = replacement;
      state.subscriptionList = [old, replacement];
      const checkout = clone(state.event);
      checkout.id = 'evt_replacement_checkout';
      checkout.data.object.id = 'cs_replacement';
      checkout.data.object.subscription = replacement.id;
      const response = await bounded(deliver({ event: checkout }), 'replacement checkout');
      assert.equal(response.status, 200, state.logs.join('\n'));
      assert.equal(state.tables.subscriptions[0].status, 'active');
      assert.equal(state.tables.subscriptions[0].plan_type, 'pro');
    } finally {
      barrier.release();
      staleResponse = await bounded(pendingCancellation, 'stale cancellation');
    }
    assert.equal(state.tables.subscriptions[0].status, 'active', 'an old provider snapshot revoked the newer checkout');
    assert.equal(state.tables.subscriptions[0].plan_type, 'pro');
    assert.equal(state.tables.subscriptions[0].stripe_subscription_id, replacement.id);
    assert.equal(staleResponse.status, 503, 'the stale writer must request reconciliation, not acknowledge an overwrite');
    assert.equal(state.observations.size, 2);
    assert.equal(state.tables.commissions.length, 0);
    assert.equal(state.tables.notifications.length, 0);
  });
}

test('stale checkout cannot reactivate after a newer confirmed cancellation', { timeout: 2500 }, async () => {
  const { state, deliver } = fixture();
  state.tables.subscriptions = [subscriptionRow({
    id: '33333333-3333-4333-8333-333333333333', stripe_customer_id: 'cus_fixture',
    stripe_subscription_id: state.subscription.id, revision: 0, plan_type: 'pro', status: 'active',
  })];
  const barrier = pauseFirstList(state);
  const pendingCheckout = deliver();
  let staleResponse;
  try {
    assert.equal((await barrier.observed()).data[0].status, 'active');
    state.subscription.status = 'canceled';
    state.subscriptionList = [clone(state.subscription)];
    const response = await bounded(deliver({ event: cancellation(state.subscription, 'evt_cancel_current') }), 'current cancellation');
    assert.equal(response.status, 200, state.logs.join('\n'));
    assert.equal(state.tables.subscriptions[0].status, 'canceled');
    assert.equal(state.tables.subscriptions[0].plan_type, 'free');
  } finally {
    barrier.release();
    staleResponse = await bounded(pendingCheckout, 'stale checkout');
  }
  assert.equal(state.tables.subscriptions[0].status, 'canceled', 'an older paid checkout reactivated a canceled subscription');
  assert.equal(state.tables.subscriptions[0].plan_type, 'free');
  assert.equal(staleResponse.status, 503);
  assert.equal(state.observations.size, 2);
});

test('a confirmed recovery with unchanged rights fences an older past-due observation', { timeout: 2500 }, async () => {
  const { state, deliver } = fixture();
  state.tables.subscriptions = [subscriptionRow({
    stripe_customer_id: 'cus_fixture', stripe_subscription_id: state.subscription.id,
    revision: 0, plan_type: 'pro', status: 'active',
  })];
  state.subscription.status = 'past_due';
  const oldEvent = cancellation(state.subscription, 'evt_old_past_due');
  oldEvent.type = 'customer.subscription.updated';
  const barrier = pauseFirstList(state);
  const pendingPastDue = deliver({ event: oldEvent });
  let staleResponse;
  try {
    assert.equal((await barrier.observed()).data[0].status, 'past_due');
    state.subscription.status = 'active';
    const response = await bounded(deliver(), 'current paid confirmation');
    assert.equal(response.status, 200, state.logs.join('\n'));
    assert.equal(state.tables.subscriptions[0].status, 'active');
  } finally {
    barrier.release();
    staleResponse = await bounded(pendingPastDue, 'old past-due observation');
  }
  assert.equal(state.tables.subscriptions[0].status, 'active', 'a newer provider confirmation must invalidate an older observation even without changing rights');
  assert.equal(staleResponse.status, 503);
  assert.equal(state.observations.size, 2);
});

test('an old cancellation cannot adopt the empty identity of a local trial', async () => {
  const { state, deliver } = fixture();
  state.tables.subscriptions = [subscriptionRow({
    stripe_customer_id: 'cus_fixture', stripe_subscription_id: null, revision: 3,
    plan_type: 'ultime', status: 'trialing', has_used_trial: true,
    trial_ends_at: '2027-01-15T00:00:00.000Z',
  })];
  const before = clone(state.tables.subscriptions[0]);
  state.subscription.status = 'canceled';
  assert.equal((await deliver({ event: cancellation(state.subscription) })).status, 503);
  assert.deepEqual(state.tables.subscriptions[0], before);
  assert.equal(state.mutations.length, 0);
  assert.equal(state.observations.size, 1);
});

for (const status of ['past_due', 'unpaid', 'paused', 'incomplete', 'incomplete_expired']) {
  test(`an old ${status} subscription cannot adopt a local trial, while its confirmed binding can still synchronize`, async () => {
    const { state, deliver } = fixture();
    state.tables.subscriptions = [subscriptionRow({
      stripe_customer_id: 'cus_fixture', stripe_subscription_id: null, revision: 1,
      plan_type: 'ultime', status: 'trialing', has_used_trial: true,
      trial_ends_at: '2027-01-15T00:00:00.000Z',
    })];
    const before = clone(state.tables.subscriptions[0]);
    state.subscription.status = status;
    const event = cancellation(state.subscription, `evt_old_${status}`);
    event.type = 'customer.subscription.updated';
    assert.equal((await deliver({ event })).status, 503);
    assert.deepEqual(state.tables.subscriptions[0], before);
    assert.equal(state.mutations.length, 0);
    assert.equal(state.observations.size, 1);

    const linked = fixture();
    linked.state.tables.subscriptions = [subscriptionRow({
      stripe_customer_id: 'cus_fixture', stripe_subscription_id: linked.state.subscription.id,
      revision: 1, plan_type: 'pro', has_used_trial: true,
    })];
    linked.state.subscription.status = status;
    const currentEvent = cancellation(linked.state.subscription, `evt_current_${status}`);
    currentEvent.type = 'customer.subscription.updated';
    assert.equal((await linked.deliver({ event: currentEvent })).status, 200);
    assert.equal(linked.state.tables.subscriptions[0].status, status);
    assert.equal(linked.state.tables.subscriptions[0].revision, 2);
    assert.equal(linked.state.tables.subscriptions[0].has_used_trial, true);
  });
}

test('a confirmed current cancellation still revokes paid rights and preserves trial history', async () => {
  const { state, deliver } = fixture();
  state.tables.subscriptions = [subscriptionRow({
    stripe_customer_id: 'cus_fixture', stripe_subscription_id: state.subscription.id,
    revision: 3, plan_type: 'pro', has_used_trial: true, trial_ends_at: '2026-01-15T00:00:00.000Z',
  })];
  state.subscription.status = 'canceled';
  assert.equal((await deliver({ event: cancellation(state.subscription) })).status, 200);
  const row = state.tables.subscriptions[0];
  assert.equal(row.plan_type, 'free');
  assert.equal(row.status, 'canceled');
  assert.equal(row.revision, 4);
  assert.equal(row.stripe_subscription_id, state.subscription.id);
  assert.equal(row.has_used_trial, true);
  assert.equal(row.trial_ends_at, '2026-01-15T00:00:00.000Z');
});

for (const revision of [undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`a missing or invalid migration revision is rejected before provider reads (${String(revision)})`, async () => {
    const { state, deliver } = fixture();
    state.tables.subscriptions = [subscriptionRow({ stripe_customer_id: 'cus_fixture', revision })];
    assert.equal((await deliver()).status, 503);
    assert.equal(state.mutations.length, 0);
    assert.equal(state.calls.some(call => call.kind === 'retrieveSubscription'), false);
  });
}

test('a lost version confirmation receipt remains retryable without granting rights again', async () => {
  const { state, deliver } = fixture();
  state.tables.subscriptions = [subscriptionRow({
    stripe_customer_id: 'cus_fixture', stripe_subscription_id: state.subscription.id,
    revision: 4, plan_type: 'pro', status: 'active', has_used_trial: true,
  })];
  state.failures.push({ table: 'subscriptions', action: 'update', afterWrite: true, data: [] });
  assert.equal((await deliver()).status, 503);
  assert.equal((await deliver()).status, 200);
  assert.equal(state.tables.subscriptions[0].revision, 6);
  assert.equal(state.tables.subscriptions[0].has_used_trial, true);
  assert.equal(state.mutations.length, 2);
  assert.ok(state.mutations.every(write => Object.keys(write.values).join(',') === 'updated_at'));
  assert.equal(state.observations.size, 1);
});

test('deleting and recreating a user row cannot satisfy an old row-id snapshot', async () => {
  const { state, deliver } = fixture();
  state.tables.subscriptions = [subscriptionRow({ stripe_customer_id: 'cus_fixture' })];
  state.beforeQuery = spec => {
    if (spec.table === 'subscriptions' && spec.action === 'update') {
      state.tables.subscriptions = [subscriptionRow({ id: 'replacement_local_row', stripe_customer_id: 'cus_fixture' })];
      state.beforeQuery = null;
    }
  };
  assert.equal((await deliver()).status, 503);
  assert.equal(state.tables.subscriptions[0].id, 'replacement_local_row');
  assert.equal(state.tables.subscriptions[0].plan_type, 'free');
  assert.equal(state.tables.subscriptions[0].revision, 0);
  assert.equal(state.mutations.length, 0);
});
