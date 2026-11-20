import { resolveStripeSubscriptionState } from "../_shared/stripe-subscription-state.ts";
import { BillingError, billingCustomer, billingJson, billingSubscription, withBillingRequest } from "../_shared/billing-boundary.ts";

const reconciliationRequired = () => billingJson({
  error: 'État de facturation à vérifier. Aucun nouveau droit accordé.',
  code: 'SUBSCRIPTION_RECONCILIATION_REQUIRED',
}, 409);

// This endpoint reports provider state only. It does not write subscription
// rights; the application reads its canonical subscription row separately.
Deno.serve(req => withBillingRequest(req, async ctx => {
  const row = await billingSubscription(ctx);
  let customerId: string;
  try {
    // Use the same identity boundary as checkout and the billing portal.
    // An email match alone is not proof that this customer belongs to the user.
    customerId = await billingCustomer(ctx, row, false);
  } catch (error) {
    if (!(error instanceof BillingError) || error.code !== "customer_missing") throw error;
    // Preserve the existing no-customer response without creating a customer.
    return billingJson({
      subscribed: false,
      plan_type: 'free',
      product_id: null,
      subscription_end: null,
    });
  }

  const activeSubscriptions = await ctx.stripe.subscriptions.list({
    customer: customerId,
    status: "active",
    limit: 2,
  });
  ctx.check();
  const trialingSubscriptions = await ctx.stripe.subscriptions.list({
    customer: customerId,
    status: "trialing",
    limit: 2,
  });
  ctx.check();

  // A partial page cannot establish a unique subscription observation.
  if (activeSubscriptions.has_more || trialingSubscriptions.has_more) return reconciliationRequired();
  const resolution = resolveStripeSubscriptionState([
    ...activeSubscriptions.data, ...trialingSubscriptions.data,
  ]);
  if (resolution.status !== 'ready') return reconciliationRequired();
  return billingJson(resolution.state);
}));
