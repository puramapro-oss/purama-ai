import assert from 'node:assert/strict';
import { resolveStripeSubscriptionState } from '../../supabase/functions/_shared/stripe-subscription-state.ts';

const end = 1_800_000_000;
const products = ['prod_UHwPcnEEVEDf4K', 'prod_UHwPSU2o4DW6Ej', 'prod_UHwPBOGTleT37J'];
const makeSubscription = (product: unknown = products[1], period: unknown = end) => ({
  status: 'active', items: { data: [{ price: { product }, current_period_end: period }] },
});
for (const [index, plan] of ['starter', 'pro', 'ultime'].entries()) {
  Deno.test(`subscription: Basil item period maps ${plan}`, () => {
    assert.deepEqual(resolveStripeSubscriptionState([makeSubscription(products[index])]), {
      status: 'ready', state: { subscribed: true, plan_type: plan, product_id: products[index], subscription_end: new Date(end * 1000).toISOString() },
    });
  });
}
Deno.test('subscription: an expanded product and trialing subscription are supported', () => {
  const subscription = makeSubscription({ id: products[1] }); subscription.status = 'trialing';
  assert.equal(resolveStripeSubscriptionState([subscription]).status, 'ready');
});
Deno.test('subscription: pre-Basil period remains compatible', () => {
  const subscription = { status: 'active', current_period_end: end, items: { data: [{ price: { product: products[1] } }] } };
  const resolution = resolveStripeSubscriptionState([subscription]);
  assert.equal(resolution.status, 'ready');
  if (resolution.status === 'ready') assert.equal(resolution.state.subscription_end, new Date(end * 1000).toISOString());
});
Deno.test('subscription: the item period takes precedence over the legacy field', () => {
  const resolution = resolveStripeSubscriptionState([{ ...makeSubscription(), current_period_end: end + 100 }]);
  if (resolution.status !== 'ready') throw new Error('Expected a valid Basil subscription');
  assert.equal(resolution.state.subscription_end, new Date(end * 1000).toISOString());
});
for (const product of ['prod_unknown', '__proto__', 'constructor', { id: products[1], deleted: true }]) {
  Deno.test(`subscription: unknown/deleted product ${JSON.stringify(product)} never grants Premium`, () => {
    assert.deepEqual(resolveStripeSubscriptionState([makeSubscription(product)]), { status: 'reconciliation_required', reason: 'unknown_product' });
  });
}
for (const period of [null, 0, -1, '1800000000', NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) {
  Deno.test(`subscription: invalid period ${String(period)} requires reconciliation`, () => {
    assert.deepEqual(resolveStripeSubscriptionState([{ ...makeSubscription(products[1], period), current_period_end: end }]), {
      status: 'reconciliation_required', reason: 'invalid_period',
    });
  });
}
Deno.test('subscription: multiple subscriptions are not silently reduced to the first', () => {
  assert.deepEqual(resolveStripeSubscriptionState([makeSubscription(), makeSubscription(products[2])]), { status: 'reconciliation_required', reason: 'multiple_subscriptions' });
});
Deno.test('subscription: multiple plan items require reconciliation', () => {
  const first = makeSubscription(); const second = makeSubscription(products[2]);
  first.items.data.push(second.items.data[0]);
  assert.deepEqual(resolveStripeSubscriptionState([first]), { status: 'reconciliation_required', reason: 'multiple_plans' });
});
Deno.test('subscription: a paginated items response cannot conceal another plan', () => {
  const subscription = makeSubscription();
  assert.deepEqual(resolveStripeSubscriptionState([{ ...subscription, items: { ...subscription.items, has_more: true } }]), {
    status: 'reconciliation_required', reason: 'paginated_items',
  });
});
Deno.test('subscription: an additional non-plan item does not select its period', () => {
  const subscription = makeSubscription();
  subscription.items.data.unshift({ price: { product: 'prod_addon_fixture' }, current_period_end: end + 100 });
  const result = resolveStripeSubscriptionState([subscription]);
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.state.subscription_end, new Date(end * 1000).toISOString());
});
Deno.test('subscription: no active subscription means no paid entitlement', () => {
  for (const subscriptions of [[], [{ ...makeSubscription(), status: 'canceled' }]]) {
    assert.deepEqual(resolveStripeSubscriptionState(subscriptions), { status: 'ready', state: { subscribed: false, plan_type: 'free', product_id: null, subscription_end: null } });
  }
});
