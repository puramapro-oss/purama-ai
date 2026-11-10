import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, request, noEffects, ownedCustomer, userId, price, prices, packPrice, intent } from './fixture.mjs';

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

for (const entry of ['create-checkout', 'customer-portal']) {
  test(`${entry}: method and bearer admission do not touch providers`, async () => {
    const h = await harness({}, entry);
    assert.equal((await h.handler(request(undefined, { method: 'OPTIONS', token: null }))).status, 200);
    assert.equal((await h.handler(request(undefined, { method: 'GET', token: null }))).status, 405);
    for (const token of [null, 'fixture-token', 'Basic fixture', 'Bearer one two', 'Bearer']) assert.equal((await h.handler(request(undefined, { token }))).status, 401);
    assert.equal(h.calls.clients.length, 0); noEffects(h);
  });
  test(`${entry}: revoked identities and missing configuration fail before billing effects`, async () => {
    for (const options of [{ noUser: true }, { authError: true }, { env: { STRIPE_SECRET_KEY: '' } }, { env: { PURAMA_BILLING_ORIGIN: 'https://user:pass@malicious.invalid/path' } }]) {
      const h = await harness(options, entry);
      const response = await h.handler(request());
      assert.ok([401, 503].includes(response.status));
      assert.doesNotMatch(await response.text(), /private-|fixture@/); noEffects(h);
    }
  });
  test(`${entry}: no caller origin can control the redirect destination`, async () => {
    const h = await harness({ env: { PURAMA_BILLING_ORIGIN: 'https://billing.purama.example' } }, entry);
    const response = await h.handler(request(undefined, { headers: { origin: 'https://attacker.invalid' } }));
    assert.equal(response.status, 200);
    const session = (entry === 'create-checkout' ? h.calls.checkout : h.calls.portal)[0].args;
    assert.equal(new URL(session.return_url ?? session.success_url).origin, 'https://billing.purama.example');
    if (session.cancel_url) assert.equal(new URL(session.cancel_url).origin, 'https://billing.purama.example');
  });
  test(`${entry}: an email match with a foreign or unknown owner cannot select a customer`, async () => {
    for (const customer of [ownedCustomer('other-user'), { id: 'cus_legacy', metadata: {} }]) {
      const h = await harness({ customers: [customer] }, entry);
      assert.equal((await h.handler(request())).status, 409); noEffects(h);
    }
  });
  test(`${entry}: multiple or truncated email matches are ambiguous`, async () => {
    for (const options of [{ customers: [ownedCustomer(), { ...ownedCustomer(), id: 'cus_second' }] }, { customersMore: true }]) {
      const h = await harness(options, entry);
      assert.equal((await h.handler(request())).status, 409); noEffects(h);
    }
  });
  test(`${entry}: database binding wins over email discovery only after owner verification`, async () => {
    const row = { user_id: userId, plan_type: 'free', status: 'active', stripe_customer_id: 'cus_owned' };
    const h = await harness({ row, retrieved: { id: 'cus_owned', metadata: {} }, bindings: [{ user_id: userId }], customers: [ownedCustomer('attacker')] }, entry);
    assert.equal((await h.handler(request())).status, 200);
    assert.deepEqual(h.calls.retrieve, ['cus_owned']); assert.equal(h.calls.customerList.length, 0);
    const effect = (entry === 'create-checkout' ? h.calls.checkout : h.calls.portal)[0];
    assert.equal(effect.args.customer, 'cus_owned');
  });
  test(`${entry}: deleted, mismatched or foreign bound customers are refused`, async () => {
    for (const retrieved of [{ id: 'cus_owned', deleted: true }, { ...ownedCustomer(), id: 'cus_unexpected' }, ownedCustomer('other-user')]) {
      const h = await harness({ row: { user_id: userId, plan_type: 'free', status: 'active', stripe_customer_id: 'cus_owned' }, retrieved }, entry);
      assert.equal((await h.handler(request())).status, 409); noEffects(h);
    }
  });
  test(`${entry}: conflicting database bindings and read failures prevent session creation`, async () => {
    for (const options of [{ bindings: [{ user_id: 'foreign' }] }, { bindings: [{ user_id: userId }, { user_id: userId }] }, { bindingError: true }, { rowError: true }]) {
      const h = await harness(options, entry);
      assert.ok([409, 503].includes((await h.handler(request())).status)); noEffects(h);
    }
  });
  test(`${entry}: malformed provider URLs never escape the response`, async () => {
    for (const url of ['http://checkout.stripe.com/a', 'javascript:alert(1)', 'https://evil.invalid/', 'https://user@checkout.stripe.com/', 'https://billing.stripe.com.evil.invalid/']) {
      const h = await harness({ [entry === 'create-checkout' ? 'checkoutUrl' : 'portalUrl']: url }, entry);
      const response = await h.handler(request());
      assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /evil|javascript/);
    }
  });
  test(`${entry}: request abort while auth waits returns promptly and prevents late effects`, async () => {
    const auth = deferred(); const h = await harness({ auth: () => auth.promise }, entry);
    const controller = new AbortController(); const pending = h.handler(request(undefined, { signal: controller.signal }));
    await settle(); controller.abort();
    assert.equal((await pending).status, 408);
    auth.resolve({ data: { user: { id: userId, email: 'fixture@email.invalid' } }, error: null });
    await settle(); noEffects(h); assert.equal(h.calls.queries.length, 0);
  });
  test(`${entry}: the total deadline stops an unresolved provider and late continuation`, async () => {
    const bindings = deferred(); const h = await harness({ manualClock: true, bindings: () => bindings.promise }, entry);
    const pending = h.handler(request()); await settle();
    assert.equal(h.calls.customerList.length, 1);
    h.advance(15_001); assert.equal((await pending).status, 504);
    bindings.resolve({ data: [], error: null }); await settle(); noEffects(h); assert.equal(h.pendingTimers(), 0);
  });
}

test('checkout: the six catalogue prices create paid subscriptions without a second trial', async () => {
  for (const priceId of prices) {
    const h = await harness(); assert.equal((await h.handler(request({ priceId, requestId: intent }))).status, 200);
    const { args, extra } = h.calls.checkout[0];
    assert.equal(args.mode, 'subscription'); assert.equal(args.line_items[0].price, priceId);
    assert.equal(args.subscription_data.trial_period_days, undefined); assert.equal(args.subscription_data.trial_end, undefined);
    assert.equal(args.metadata.user_id, userId); assert.equal(args.subscription_data.metadata.user_id, userId);
    assert.ok(extra.idempotencyKey); assert.equal(h.calls.network.length, 0);
  }
});
test('checkout: unknown prices and forged oneTime cannot bypass the catalogue', async () => {
  for (const priceId of ['', 'price_not_in_catalog', 42, null]) {
    const h = await harness(); assert.equal((await h.handler(request({ priceId, oneTime: true }))).status, 400); noEffects(h);
  }
  const h = await harness(); assert.equal((await h.handler(request({ priceId: price, oneTime: true }))).status, 200);
  assert.equal(h.calls.checkout[0].args.mode, 'subscription');
});
test('checkout: an existing paid local plan blocks a second subscription before provider effects', async () => {
  const h = await harness({ row: { user_id: userId, plan_type: 'pro', status: 'active', stripe_customer_id: 'cus_owned' } });
  assert.equal((await h.handler(request())).status, 409); noEffects(h);
});
test('checkout: every nonterminal provider state blocks a second subscription', async () => {
  for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused', 'unknown_future_status']) {
    const h = await harness({ subscriptions: [{ status }] });
    assert.equal((await h.handler(request())).status, 409); noEffects(h);
  }
  const h = await harness({ subscriptionsMore: true }); assert.equal((await h.handler(request())).status, 409); noEffects(h);
});
test('checkout: canceled and expired provider subscriptions permit an explicit paid conversion', async () => {
  const h = await harness({ subscriptions: [{ status: 'canceled' }, { status: 'incomplete_expired' }], row: { user_id: userId, plan_type: 'pro', status: 'trialing', stripe_customer_id: null } });
  assert.equal((await h.handler(request())).status, 200); assert.equal(h.calls.checkout.length, 1);
});
test('checkout: overage remains a one-time pack while an existing subscription is active', async () => {
  const h = await harness({ row: { user_id: userId, plan_type: 'pro', status: 'active', stripe_customer_id: 'cus_owned' }, subscriptions: [{ status: 'active' }] });
  assert.equal((await h.handler(request({ priceId: packPrice, requestId: intent, oneTime: false }))).status, 200);
  const params = h.calls.checkout[0].args;
  assert.equal(params.mode, 'payment'); assert.equal(params.metadata.type, 'overage_pack'); assert.equal(params.metadata.actions, '2000');
  assert.equal(params.subscription_data, undefined); assert.equal(h.calls.subscriptions.length, 0);
  assert.equal(params.success_url, 'https://purama-ai.purama.dev/dashboard/billing?overage_success=true');
  assert.equal(params.cancel_url, 'https://purama-ai.purama.dev/dashboard/billing?overage_canceled=true');
});
test('checkout: new customer is owner-tagged and creation retry keys are stable per user', async () => {
  const keys = [];
  for (const id of [userId, userId, 'fixture-user-b']) {
    const h = await harness({ userId: id, customers: [], row: null });
    assert.equal((await h.handler(request())).status, 200);
    const created = h.calls.createCustomer[0]; assert.equal(created.args.metadata.user_id, id);
    keys.push(created.extra.idempotencyKey); assert.equal(h.calls.checkout[0].args.customer, 'cus_created');
  }
  assert.equal(keys[0], keys[1]); assert.notEqual(keys[0], keys[2]);
});
test('portal: missing customer never creates one', async () => {
  const h = await harness({ customers: [] }, 'customer-portal');
  assert.equal((await h.handler(request())).status, 409); noEffects(h);
});
test('checkout: retry key is stable for one user and intent, isolated across users and intents', async () => {
  const keys = [];
  for (const [id, requestId] of [[userId, intent], [userId, intent], ['fixture-user-b', intent], [userId, '30c2b2bd-f987-43c2-8580-63cb11bef540']]) {
    const h = await harness({ userId: id }); assert.equal((await h.handler(request({ priceId: price, requestId }))).status, 200);
    keys.push(h.calls.checkout[0].extra.idempotencyKey);
  }
  assert.equal(keys[0], keys[1]); assert.notEqual(keys[0], keys[2]); assert.notEqual(keys[0], keys[3]);
  assert.doesNotMatch(keys.join(''), /fixture-user|fixture@/);
});
test('checkout: malformed input, request identifiers and referral types cause no provider effects', async () => {
  for (const body of [null, [], '{', {}, { priceId: price, requestId: 7 }, { priceId: price, requestId: 'invalid' }, { priceId: price, referralCode: {} }]) {
    const h = await harness(); assert.equal((await h.handler(request(body))).status, 400); noEffects(h);
  }
});
test('checkout: body limits and declared-length mismatch refuse input before billing reads', async () => {
  for (const [body, headers, status] of [[' '.repeat(4097), {}, 413], [JSON.stringify({ priceId: price }), { 'content-length': '1' }, 400]]) {
    const h = await harness(); assert.equal((await h.handler(request(body, { headers }))).status, status);
    noEffects(h); assert.equal(h.calls.queries.length, 0);
  }
});
test('checkout: a stalled request body is bounded and cancelled with no late session', async () => {
  const h = await harness({ manualClock: true }); let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const pending = h.handler(request(stream, { duplex: 'half' })); await settle(); h.advance(5_001);
  assert.equal((await pending).status, 408); assert.equal(cancelled, true); noEffects(h);
});
test('checkout: valid referral preserves its coupon and metadata', async () => {
  const h = await harness({ influencer: { id: 'affiliate-fixture', beneficiary_name: 'Fixture', promo_code: 'CODE', contract_status: 'signed', expires_at: '2099-01-01' } });
  const response = await h.handler(request({ priceId: price, requestId: intent, referralCode: 'code' }));
  assert.equal(response.status, 200); assert.equal((await response.json()).hasDiscount, true);
  const args = h.calls.checkout[0].args;
  assert.equal(h.calls.queries.find(query => query.table === 'influencers').columns, 'id, beneficiary_name, promo_code, contract_status, expires_at');
  assert.equal(args.discounts[0].coupon, 'lHDOePig'); assert.equal(args.metadata.influencer_id, 'affiliate-fixture');
  assert.ok(h.calls.queries.some(query => query.table === 'influencers' && query.filters.some(([key, value]) => key === 'promo_code' && value === 'CODE')));
});
test('checkout: missing, expired and failed referral lookups never silently remove the discount', async () => {
  for (const options of [{}, { influencer: { id: 'affiliate-fixture', expires_at: '2000-01-01' } }, { referralError: true }]) {
    const h = await harness(options); assert.ok([400, 503].includes((await h.handler(request({ priceId: price, referralCode: 'CODE' }))).status)); noEffects(h);
  }
});
test('checkout: abort after customer discovery prevents later customer/session effects', async () => {
  const wait = deferred(); const h = await harness({ customerList: () => wait.promise });
  const controller = new AbortController(); const pending = h.handler(request(undefined, { signal: controller.signal })); await settle(); controller.abort();
  assert.equal((await pending).status, 408); wait.resolve({ data: [], has_more: false }); await settle(); noEffects(h);
});
test('billing: provider exceptions are generic and carry no private data', async () => {
  const h = await harness({ subscriptionsThrows: true }); const response = await h.handler(request());
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private-|fixture@/);
  assert.doesNotMatch(JSON.stringify(h.calls.logs), /private-|fixture@/); noEffects(h);
});

test('billing: configured SDK transports inherit cancellation and are aborted on completion', async () => {
  const wait = deferred();
  const h = await harness({ auth: () => wait.promise });
  const pending = h.handler(request()); await settle();
  const transport = h.calls.clients[0].config.global.fetch;
  await assert.rejects(transport('https://transport-fixture.invalid'), /Network forbidden/);
  const signal = h.calls.network[0][1].signal;
  assert.equal(signal.aborted, false);
  wait.resolve({ data: { user: null }, error: null });
  assert.equal((await pending).status, 401);
  assert.equal(signal.aborted, true);
});
test('billing: a checkout provider resolving after the deadline never returns a successful link', async () => {
  const wait = deferred(); const h = await harness({ manualClock: true, checkout: () => wait.promise });
  const pending = h.handler(request()); await settle();
  assert.equal(h.calls.checkout.length, 1, 'the provider request began before the deadline');
  h.advance(15_001); const response = await pending;
  assert.equal(response.status, 504); assert.doesNotMatch(await response.text(), /checkout.stripe.com/);
  wait.resolve({ id: 'cs_late', url: 'https://checkout.stripe.com/c/pay/late' });
  await settle(); assert.equal(h.calls.checkout.length, 1); assert.equal(h.pendingTimers(), 0);
});
