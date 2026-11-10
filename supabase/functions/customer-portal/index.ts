import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { billingCustomer, billingJson, billingOrigin, billingSubscription, stripeRedirect, withBillingRequest } from "../_shared/billing-boundary.ts";

serve(req => withBillingRequest(req, async ctx => {
  const customer = await billingCustomer(ctx, await billingSubscription(ctx), false);
  ctx.check();
  const session = await ctx.stripe.billingPortal.sessions.create({ customer, return_url: `${billingOrigin()}/pricing` });
  ctx.check();
  return billingJson({ url: stripeRedirect(session.url, "billing.stripe.com") });
}));
