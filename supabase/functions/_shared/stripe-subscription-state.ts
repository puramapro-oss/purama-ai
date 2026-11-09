/** Read-only normalization. This module never creates rights, charges or commissions. */
const plans = new Map([
  ['prod_UHwPcnEEVEDf4K', 'starter'],
  ['prod_UHwPSU2o4DW6Ej', 'pro'],
  ['prod_UHwPBOGTleT37J', 'ultime'],
]);

type SubscriptionState = {
  subscribed: boolean;
  plan_type: string;
  product_id: string | null;
  subscription_end: string | null;
};
export type SubscriptionResolution =
  | { status: 'ready'; state: SubscriptionState }
  | { status: 'reconciliation_required'; reason: 'invalid_response' | 'multiple_subscriptions' | 'unknown_product' | 'multiple_plans' | 'invalid_period' | 'paginated_items' };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function productId(item: Record<string, unknown>): string | undefined {
  const product = record(item.price)?.product;
  if (typeof product === 'string') return product;
  const expanded = record(product);
  return expanded?.deleted !== true && typeof expanded?.id === 'string' ? expanded.id : undefined;
}

export function resolveStripeSubscriptionState(subscriptions: unknown): SubscriptionResolution {
  if (!Array.isArray(subscriptions)) return { status: 'reconciliation_required', reason: 'invalid_response' };
  const active = subscriptions.map(record).filter((entry): entry is Record<string, unknown> =>
    Boolean(entry && (entry.status === 'active' || entry.status === 'trialing')));
  if (active.length === 0) return { status: 'ready', state: {
    subscribed: false, plan_type: 'free', product_id: null, subscription_end: null,
  } };
  // Never select an arbitrary subscription when an account needs reconciliation.
  if (active.length !== 1) return { status: 'reconciliation_required', reason: 'multiple_subscriptions' };
  const subscription = active[0];
  const itemPage = record(subscription.items);
  if (itemPage?.has_more === true) return { status: 'reconciliation_required', reason: 'paginated_items' };
  const items = itemPage?.data;
  if (!Array.isArray(items)) return { status: 'reconciliation_required', reason: 'invalid_response' };
  const mapped = items.map(record).filter((item): item is Record<string, unknown> => Boolean(item))
    .map(item => ({ item, product: productId(item) }))
    .filter((entry): entry is { item: Record<string, unknown>; product: string } =>
      typeof entry.product === 'string' && plans.has(entry.product));
  if (!mapped.length) return { status: 'reconciliation_required', reason: 'unknown_product' };
  if (mapped.length !== 1) return { status: 'reconciliation_required', reason: 'multiple_plans' };
  const { item, product } = mapped[0];
  // Basil moved period dates to SubscriptionItem. Only pre-Basil objects use the fallback.
  const seconds = item.current_period_end === undefined
    ? subscription.current_period_end : item.current_period_end;
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0) {
    return { status: 'reconciliation_required', reason: 'invalid_period' };
  }
  const end = new Date(seconds * 1000);
  if (!Number.isFinite(end.getTime())) return { status: 'reconciliation_required', reason: 'invalid_period' };
  return { status: 'ready', state: {
    subscribed: true, plan_type: plans.get(product)!, product_id: product,
    subscription_end: end.toISOString(),
  } };
}
