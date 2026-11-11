import assert from 'node:assert/strict';
import { fixture, resetFixture } from './webhook-provider-fixture.ts';
import { getHandler } from './serve-capture.ts';
import '../../supabase/functions/stripe-webhook/index.ts';

for (const [name, value] of Object.entries({
  STRIPE_SECRET_KEY: 'sk_test_inert_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_inert_fixture',
  SUPABASE_URL: 'https://fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'inert_fixture', RESEND_API_KEY: '',
})) Deno.env.set(name, value);
const handler = getHandler();
const now = Math.floor(Date.now() / 1000);
const trialEnd = now + 7 * 86400;
function checkout(overrides: Record<string, unknown> = {}) {
  return { id: 'cs_fixture', mode: 'subscription', status: 'complete', payment_status: 'paid',
    subscription: 'sub_fixture', customer: 'cus_fixture', customer_email: 'fixture@example.invalid', metadata: {},
    created: now - 60, livemode: false, ...overrides };
}
async function send(type: string, object: unknown, signature = 'inert-valid-signature') {
  fixture.event = { id: 'evt_fixture', type, data: { object }, created: now, livemode: false };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (signature) headers['stripe-signature'] = signature;
  return handler(new Request('https://fixture.invalid/webhook', { method: 'POST', headers, body: '{}' }));
}
const update = () => send('customer.subscription.updated', fixture.subscription);
const grants = () => fixture.writes.filter(x => x.table === 'subscriptions');

Deno.test('webhook harness has no network or process execution permission', async () => {
  assert.equal((await Deno.permissions.query({ name: 'net' })).state, 'denied');
  assert.equal((await Deno.permissions.query({ name: 'run' })).state, 'denied');
});
Deno.test('webhook: known paid products preserve the three IAO plan IDs', async () => {
  for (const [product, plan] of [['prod_UHwPcnEEVEDf4K', 'starter'], ['prod_UHwPSU2o4DW6Ej', 'pro'], ['prod_UHwPBOGTleT37J', 'ultime']]) {
    resetFixture(); fixture.subscription.items.data[0].price.product = product;
    assert.equal((await send('checkout.session.completed', checkout())).status, 200);
    assert.equal(fixture.subscriptionRow.plan_type, plan); assert.equal(fixture.subscriptionRow.status, 'active');
    assert.equal(grants().length, 1); assert.equal(fixture.subscriptionRow.has_used_trial, true);
  }
});
Deno.test('webhook: unpaid or missing payment status cannot grant a subscription or commission', async () => {
  for (const status of ['unpaid', undefined]) {
    resetFixture();
    assert.equal((await send('checkout.session.completed', checkout({ payment_status: status,
      metadata: { referral_code: 'INERT', influencer_id: 'fixture-influencer' } }))).status, 200);
    assert.equal(fixture.writes.length, 0); assert.equal(fixture.subscriptionRow.plan_type, 'free');
  }
});
Deno.test('webhook: unknown and prototype-like checkout products never fall back to pro', async () => {
  for (const product of ['prod_unknown', 'constructor', '__proto__']) {
    resetFixture(); fixture.subscription.items.data[0].price.product = product;
    assert.equal((await send('checkout.session.completed', checkout())).status, 500);
    assert.equal(fixture.writes.length, 0); assert.equal(fixture.subscriptionRow.plan_type, 'free');
  }
});
Deno.test('webhook: unknown subscription-update products never fall back to pro', async () => {
  resetFixture(); fixture.subscription.items.data[0].price.product = 'prod_unknown';
  assert.equal((await update()).status, 500); assert.equal(grants().length, 0);
});
Deno.test('webhook: a known expanded product and customer preserve exact identity', async () => {
  resetFixture(); fixture.subscription.items.data[0].price.product = { id: 'prod_UHwPBOGTleT37J' };
  fixture.subscription.customer = { id: 'cus_fixture' };
  fixture.invoice.customer = { id: 'cus_fixture' };
  assert.equal((await send('checkout.session.completed', checkout({ customer: { id: 'cus_fixture' } }))).status, 200);
  assert.equal(fixture.subscriptionRow.plan_type, 'ultime'); assert.equal(fixture.subscriptionRow.stripe_customer_id, 'cus_fixture');
});
Deno.test('webhook: deleted products and ambiguous or paginated items require reconciliation', async () => {
  for (const shape of ['deleted', 'multiple', 'paginated', 'empty']) {
    resetFixture();
    if (shape === 'deleted') fixture.subscription.items.data[0].price.product = { id: 'prod_UHwPSU2o4DW6Ej', deleted: true };
    if (shape === 'multiple') fixture.subscription.items.data.push({ price: { product: 'prod_UHwPBOGTleT37J' } });
    if (shape === 'paginated') fixture.subscription.items.has_more = true;
    if (shape === 'empty') fixture.subscription.items.data = [];
    assert.equal((await send('checkout.session.completed', checkout())).status, 500);
    assert.equal(grants().length, 0);
  }
});
Deno.test('webhook: open and expired checkout sessions cannot activate access', async () => {
  for (const status of ['open', 'expired']) {
    resetFixture(); assert.equal((await send('checkout.session.completed', checkout({ status }))).status, 500);
    assert.equal(grants().length, 0);
  }
});
Deno.test('webhook: a paid checkout does not turn a non-active subscription active', async () => {
  for (const status of ['incomplete', 'past_due', 'canceled', 'unpaid', 'paused']) {
    resetFixture(); fixture.subscription.status = status;
    assert.equal((await send('checkout.session.completed', checkout())).status, 200); assert.equal(grants().length, 0);
  }
});
Deno.test('webhook: an active subscription still requires its current paid invoice', async () => {
  for (const type of ['checkout.session.completed', 'customer.subscription.updated']) {
    resetFixture(); fixture.invoice.status = 'open';
    assert.equal((await send(type, type.startsWith('checkout') ? checkout() : fixture.subscription)).status, 500);
    assert.equal(grants().length, 0);
  }
});
Deno.test('webhook: a missing or unrelated invoice cannot confirm paid access', async () => {
  for (const shape of ['missing', 'other-customer']) {
    resetFixture();
    if (shape === 'missing') fixture.subscription.latest_invoice = null;
    else fixture.invoice.customer = 'cus_other';
    assert.equal((await update()).status, 500); assert.equal(grants().length, 0);
  }
});
Deno.test('webhook: checkout and subscription must identify the same customer', async () => {
  resetFixture(); fixture.subscription.customer = 'cus_other'; fixture.invoice.customer = 'cus_other';
  assert.equal((await send('checkout.session.completed', checkout())).status, 500); assert.equal(grants().length, 0);
});
Deno.test('webhook: existing Stripe trials retain trialing and the provider deadline', async () => {
  for (const paymentStatus of ['paid', 'no_payment_required']) {
    resetFixture(); fixture.subscription.status = 'trialing'; fixture.subscription.trial_end = trialEnd;
    fixture.subscriptionRow.has_used_trial = false;
    assert.equal((await send('checkout.session.completed', checkout({ payment_status: paymentStatus }))).status, 200);
    assert.equal(fixture.subscriptionRow.status, 'trialing'); assert.equal(fixture.subscriptionRow.has_used_trial, true);
    assert.equal(fixture.subscriptionRow.trial_ends_at, new Date(trialEnd * 1000).toISOString());
    assert.equal(fixture.calls.some(x => x.operation === 'retrieveInvoice'), false);
  }
});
Deno.test('webhook: trial-update replay cannot restart or extend the provider deadline', async () => {
  resetFixture(); fixture.subscription.status = 'trialing'; fixture.subscription.trial_end = trialEnd;
  assert.equal((await update()).status, 200); const deadline = fixture.subscriptionRow.trial_ends_at;
  assert.equal((await update()).status, 200); assert.equal(fixture.subscriptionRow.trial_ends_at, deadline);
  assert.equal(deadline, new Date(trialEnd * 1000).toISOString()); assert.equal(fixture.subscriptionRow.has_used_trial, true);
});
Deno.test('webhook: an expired or unproven legacy trial cannot grant access', async () => {
  for (const deadline of [null, now - 1]) {
    resetFixture(); fixture.subscription.status = 'trialing'; fixture.subscription.trial_end = deadline;
    assert.equal((await send('checkout.session.completed', checkout())).status, 500); assert.equal(grants().length, 0);
  }
});
Deno.test('webhook: no-payment-required is not inferred to be a paid active subscription', async () => {
  resetFixture(); assert.equal((await send('checkout.session.completed', checkout({ payment_status: 'no_payment_required' }))).status, 200);
  assert.equal(grants().length, 0);
});
Deno.test('webhook: confirmed delayed subscription payment reaches the real handler', async () => {
  resetFixture(); assert.equal((await send('checkout.session.completed', checkout({ payment_status: 'unpaid' }))).status, 200);
  assert.equal(grants().length, 0);
  assert.equal((await send('checkout.session.async_payment_succeeded', checkout())).status, 200);
  assert.equal(grants().length, 1); assert.equal(fixture.subscriptionRow.status, 'active');
});
Deno.test('webhook: an old active update cannot undo the current Stripe cancellation', async () => {
  resetFixture(); const old = structuredClone(fixture.subscription); fixture.subscription.status = 'canceled';
  assert.equal((await send('customer.subscription.updated', old)).status, 200);
  assert.equal(fixture.subscriptionRow.status, 'canceled'); assert.equal(fixture.subscriptionRow.has_used_trial, true);
});
Deno.test('webhook: paid subscription update preserves exact known plan and trial history', async () => {
  resetFixture(); fixture.subscription.items.data[0].price.product = 'prod_UHwPcnEEVEDf4K';
  assert.equal((await update()).status, 200); assert.equal(fixture.subscriptionRow.plan_type, 'starter');
  assert.equal(fixture.subscriptionRow.status, 'active'); assert.equal(fixture.subscriptionRow.has_used_trial, true);
});
Deno.test('webhook: a bad or absent signature cannot reach any entitlement write', async () => {
  resetFixture(); assert.equal((await send('checkout.session.completed', checkout(), '')).status, 400); assert.equal(grants().length, 0);
  resetFixture(); fixture.failSignature = true;
  assert.equal((await send('checkout.session.completed', checkout())).status, 400); assert.equal(grants().length, 0);
});
function pack(paymentStatus = 'paid') {
  return checkout({ mode: 'payment', subscription: null, payment_status: paymentStatus,
    metadata: { user_id: '00000000-0000-4000-8000-000000002701', type: 'overage_pack' },
    amount_total: 1900, currency: 'eur', payment_intent: 'pi_fixture' });
}
Deno.test('webhook: the paid 19EUR/2000-action pack keeps stable credit identities on redelivery', async () => {
  resetFixture(); const session = pack();
  assert.equal((await send('checkout.session.completed', session)).status, 200);
  assert.equal((await send('checkout.session.completed', session)).status, 200);
  const calls = fixture.calls.filter(x => x.operation === 'rpc.credit_overage_pack');
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].value, calls[1].value);
  const credit = calls[0].value as Record<string, unknown>;
  assert.equal(credit.p_payment_amount_total, 1900); assert.equal(credit.p_actions, 2000);
  assert.equal(fixture.creditedSessions.size, 1); assert.equal(grants().length, 0);
});
Deno.test('webhook: delayed overage remains isolated from subscription activation', async () => {
  resetFixture(); assert.equal((await send('checkout.session.completed', pack('unpaid'))).status, 200);
  assert.equal(fixture.creditedSessions.size, 0);
  assert.equal((await send('checkout.session.async_payment_succeeded', pack())).status, 200);
  assert.equal(fixture.creditedSessions.size, 1); assert.equal(grants().length, 0);
});
Deno.test('webhook: an unconfirmed async pack is rejected without any credit', async () => {
  resetFixture(); assert.equal((await send('checkout.session.async_payment_succeeded', pack('unpaid'))).status, 500);
  assert.equal(fixture.creditedSessions.size, 0); assert.equal(grants().length, 0);
});
Deno.test('webhook: an unrelated one-time payment never grants a subscription', async () => {
  resetFixture(); assert.equal((await send('checkout.session.completed', checkout({ mode: 'payment', metadata: {} }))).status, 200);
  assert.equal(fixture.writes.length, 0); assert.equal(fixture.creditedSessions.size, 0);
});
Deno.test('webhook: deletion never clears the consumed-trial marker', async () => {
  resetFixture(); assert.equal((await send('customer.subscription.deleted', fixture.subscription)).status, 200);
  assert.equal(fixture.subscriptionRow.status, 'canceled'); assert.equal(fixture.subscriptionRow.plan_type, 'free');
  assert.equal(fixture.subscriptionRow.has_used_trial, true);
});

const nonSubscriptionWrites = () => fixture.writes.filter(x => x.table !== 'subscriptions');
function referralCheckout() {
  fixture.influencer = { id: 'fixture-influencer', user_id: 'fixture-beneficiary', commission_rate: 30,
    total_revenue: 0, total_sales: 0, beneficiary_name: 'Fixture' };
  return checkout({ metadata: { influencer_id: 'fixture-influencer', referral_code: 'FIXTURE', user_id: 'untrusted-metadata-user' } });
}
Deno.test('webhook: persisted customer binding works without display email or metadata authority', async () => {
  resetFixture(); fixture.users = [];
  assert.equal((await send('checkout.session.completed', checkout({ customer_email: null,
    metadata: { user_id: 'untrusted-other-user' } }))).status, 200);
  assert.equal(fixture.subscriptionRow.plan_type, 'pro'); assert.equal(grants().length, 1);
  assert.equal(fixture.calls.filter(x => x.operation === 'listUsers').length, 0);
});
Deno.test('webhook: stored binding wins over a different account with the same display email', async () => {
  resetFixture(); fixture.users = [{ id: 'other-user', email: 'fixture@example.invalid' }];
  assert.equal((await send('checkout.session.completed', checkout())).status, 200);
  assert.equal(fixture.subscriptionRow.plan_type, 'pro');
  assert.equal(fixture.calls.filter(x => x.operation === 'listUsers').length, 0);
});
Deno.test('webhook: legacy exact lookup reaches users after the first 20000 accounts', async () => {
  resetFixture(); fixture.subscriptionRow.stripe_customer_id = null;
  const target = fixture.users[0];
  fixture.users = Array.from({ length: 20000 }, (_, i) => ({ id: `legacy-${i}`, email: `legacy-${i}@example.invalid` }));
  fixture.users.push(target);
  assert.equal((await send('checkout.session.completed', checkout())).status, 200);
  assert.equal(fixture.subscriptionRow.plan_type, 'pro'); assert.equal(fixture.subscriptionRow.stripe_customer_id, 'cus_fixture');
  const pages = fixture.calls.filter(x => x.operation === 'listUsers').map(x => x.value);
  assert.equal(pages.length, 22); assert.deepEqual(pages[21], { page: 22, perPage: 1000 });
  fixture.calls = [];
  assert.equal((await send('checkout.session.completed', checkout())).status, 200);
  assert.equal(fixture.calls.filter(x => x.operation === 'listUsers').length, 0);
});
Deno.test('webhook: a later duplicate exact email is rejected before the first match can grant', async () => {
  resetFixture(); fixture.subscriptionRow.stripe_customer_id = null; const target = fixture.users[0];
  fixture.users = [target, ...Array.from({ length: 999 }, (_, i) => ({ id: `other-${i}`, email: `other-${i}@example.invalid` })),
    { id: 'second-account-with-same-email', email: target.email }];
  assert.equal((await send('checkout.session.completed', checkout())).status, 500); assert.equal(grants().length, 0);
});
Deno.test('webhook: legacy pagination errors after a match never authorize partial results', async () => {
  for (const malformed of [false, true]) {
    resetFixture(); fixture.subscriptionRow.stripe_customer_id = null;
    if (malformed) fixture.malformedUserPage = 2; else fixture.failUserPage = 2;
    assert.equal((await send('checkout.session.completed', checkout())).status, 500); assert.equal(grants().length, 0);
  }
});
Deno.test('webhook: repeated pages and bounded catalog exhaustion fail closed', async () => {
  resetFixture(); fixture.subscriptionRow.stripe_customer_id = null; fixture.repeatUserPage = true;
  assert.equal((await send('checkout.session.completed', checkout())).status, 500); assert.equal(grants().length, 0);
  assert.equal(fixture.calls.filter(x => x.operation === 'listUsers').length, 2);
  resetFixture(); fixture.subscriptionRow.stripe_customer_id = null; fixture.neverEndingUserPages = true;
  assert.equal((await send('checkout.session.completed', checkout())).status, 500); assert.equal(grants().length, 0);
  assert.equal(fixture.calls.filter(x => x.operation === 'listUsers').length, 50);
});
Deno.test('webhook: absent legacy user or missing email cannot be replaced by metadata.user_id', async () => {
  for (const email of ['absent@example.invalid', null]) {
    resetFixture(); fixture.subscriptionRow.stripe_customer_id = null;
    assert.equal((await send('checkout.session.completed', checkout({ customer_email: email,
      metadata: { user_id: fixture.subscriptionRow.user_id } }))).status, 500);
    assert.equal(grants().length, 0);
  }
});
Deno.test('webhook: exact legacy matching neither folds case nor invents a local subscription', async () => {
  resetFixture(); fixture.subscriptionRow.stripe_customer_id = null;
  assert.equal((await send('checkout.session.completed', checkout({ customer_email: 'FIXTURE@example.invalid' }))).status, 500);
  assert.equal(grants().length, 0);
  resetFixture(); fixture.subscriptionAbsent = true;
  assert.equal((await send('checkout.session.completed', checkout())).status, 500); assert.equal(grants().length, 0);
});
Deno.test('webhook: legacy fallback cannot replace another persisted customer binding', async () => {
  resetFixture(); fixture.subscriptionRow.stripe_customer_id = 'cus_other';
  assert.equal((await send('checkout.session.completed', checkout())).status, 500);
  assert.equal(fixture.subscriptionRow.stripe_customer_id, 'cus_other'); assert.equal(grants().length, 0);
});
Deno.test('webhook: ambiguous customer bindings and lookup failures never fall back to email', async () => {
  for (const broken of ['ambiguous', 'failed']) {
    resetFixture();
    if (broken === 'failed') fixture.failLookup = true;
    else fixture.additionalSubscriptions.push({ ...fixture.subscriptionRow, id: 'duplicate-row', user_id: 'other-user' });
    assert.equal((await send('checkout.session.completed', checkout())).status, 500); assert.equal(grants().length, 0);
    assert.equal(fixture.calls.filter(x => x.operation === 'listUsers').length, 0);
  }
});
Deno.test('webhook: a customer binding changed during persistence cannot be overwritten', async () => {
  resetFixture(); fixture.changeCustomerOnWrite = 'cus_reassigned';
  assert.equal((await send('checkout.session.completed', referralCheckout())).status, 500);
  assert.equal(fixture.subscriptionRow.stripe_customer_id, 'cus_reassigned');
  assert.equal(fixture.subscriptionRow.plan_type, 'free'); assert.equal(nonSubscriptionWrites().length, 0);
});
Deno.test('webhook: all four subscription writes fail retryably before later effects', async () => {
  for (const type of ['checkout.session.completed', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_failed']) {
    resetFixture(); fixture.failPersistence = true;
    const object = type.startsWith('checkout') ? referralCheckout() : type.startsWith('invoice') ? fixture.invoice : fixture.subscription;
    assert.equal((await send(type, object)).status, 500, type);
    assert.equal(nonSubscriptionWrites().length, 0, type);
    assert.equal(fixture.calls.some(x => x.operation === 'inert.email'), false);
  }
});
Deno.test('webhook: missing write receipt stops before commission even when the row was changed', async () => {
  resetFixture(); fixture.missingWriteReceipt = true;
  assert.equal((await send('checkout.session.completed', referralCheckout())).status, 500);
  assert.equal(fixture.subscriptionRow.plan_type, 'pro'); assert.equal(nonSubscriptionWrites().length, 0);
});
Deno.test('webhook: retry after a failed subscription write reaches commission only once', async () => {
  resetFixture(); fixture.failPersistence = true; const session = referralCheckout();
  assert.equal((await send('checkout.session.completed', session)).status, 500);
  assert.equal(nonSubscriptionWrites().length, 0);
  fixture.failPersistence = false;
  assert.equal((await send('checkout.session.completed', session)).status, 200);
  assert.equal(fixture.writes.filter(x => x.table === 'commissions' && x.operation === 'insert').length, 1);
  assert.equal(fixture.subscriptionRow.plan_type, 'pro');
});
Deno.test('webhook: missing or ambiguous bindings for updates, deletion and invoice failure require reconciliation', async () => {
  for (const type of ['customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_failed']) {
    for (const broken of ['missing', 'ambiguous']) {
      resetFixture();
      if (broken === 'missing') fixture.subscriptionAbsent = true;
      else fixture.additionalSubscriptions.push({ ...fixture.subscriptionRow, id: 'duplicate-row', user_id: 'other-user' });
      assert.equal((await send(type, type.startsWith('invoice') ? fixture.invoice : fixture.subscription)).status, 500);
      assert.equal(grants().length, 0);
    }
  }
});
