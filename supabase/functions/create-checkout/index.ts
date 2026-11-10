import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import type Stripe from "https://esm.sh/stripe@18.5.0";
import { PLANS, OVERAGE_PACK } from "../../../src/lib/plans.ts";
import { readRequestText, RequestBodyError } from "../_shared/request-body.ts";
import { BillingError, billingCustomer, billingJson, billingKey, billingOrigin, billingSubscription, stripeRedirect, withBillingRequest } from "../_shared/billing-boundary.ts";

const COUPON_50_PERCENT = "lHDOePig";
const subscriptionPrices = new Set(Object.values(PLANS).flatMap(plan => [plan.monthly_price_id, plan.yearly_price_id]).filter((price): price is string => !!price));

serve(req => withBillingRequest(req, async ctx => {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readRequestText(req, { maxBytes: 4_096, timeoutMs: 5_000 }));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestBodyError) throw new BillingError(error.status, "invalid_request", "La demande de paiement est invalide ou trop volumineuse.");
    throw new BillingError(400, "invalid_request", "La demande de paiement est invalide.");
  }
  ctx.check();
  const priceId = body.priceId;
  const oneTime = priceId === OVERAGE_PACK.price_id;
  if (typeof priceId !== "string" || (!oneTime && !subscriptionPrices.has(priceId))) throw new BillingError(400, "unknown_price", "Cette offre de paiement n’est pas disponible.");
  const requestId = body.requestId ?? crypto.randomUUID();
  if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new BillingError(400, "invalid_request_id", "La demande de paiement est invalide.");
  if (body.referralCode !== undefined && (typeof body.referralCode !== "string" || !/^[a-z0-9_-]{1,80}$/i.test(body.referralCode))) throw new BillingError(400, "invalid_referral", "Le code de parrainage est invalide.");

  const row = await billingSubscription(ctx);
  if (!oneTime && row?.status === "active" && row.plan_type !== "free") throw new BillingError(409, "subscription_exists", "Gère ton abonnement existant depuis la facturation.");
  const customer = await billingCustomer(ctx, row, true);
  if (!oneTime) {
    const subscriptions = await ctx.stripe.subscriptions.list({ customer, status: "all", limit: 100 });
    ctx.check();
    if (subscriptions.has_more || subscriptions.data.some((subscription: Stripe.Subscription) => !["canceled", "incomplete_expired"].includes(subscription.status))) {
      throw new BillingError(409, "subscription_exists", "Un abonnement existe déjà ou nécessite une vérification dans la facturation.");
    }
  }

  let influencer: { id: string; beneficiary_name: string | null; promo_code: string } | null = null;
  if (typeof body.referralCode === "string") {
    const { data, error } = await ctx.db.from("influencers").select("id, beneficiary_name, promo_code, contract_status, expires_at").eq("promo_code", body.referralCode.toUpperCase()).eq("contract_status", "signed").maybeSingle();
    ctx.check();
    if (error) throw new BillingError(503, "referral_unavailable", "Impossible de vérifier la réduction. Réessaie dans un instant.");
    if (data && new Date(data.expires_at).getTime() > Date.now()) influencer = data;
    if (!influencer) throw new BillingError(400, "invalid_referral", "Le code de parrainage n’est pas actif.");
  }
  const origin = billingOrigin();
  const metadata = { user_id: ctx.user.id, ...(influencer ? { referral_code: influencer.promo_code, influencer_id: influencer.id } : {}) };
  const params: Stripe.Checkout.SessionCreateParams = {
    customer, client_reference_id: ctx.user.id, line_items: [{ price: priceId, quantity: 1 }],
    mode: oneTime ? "payment" : "subscription",
    success_url: `${origin}${oneTime ? "/dashboard/billing?overage_success=true" : "/pricing?success=true"}`,
    cancel_url: `${origin}${oneTime ? "/dashboard/billing?overage_canceled=true" : "/pricing?canceled=true"}`,
    metadata: oneTime ? { ...metadata, type: "overage_pack", actions: String(OVERAGE_PACK.actions) } : metadata,
    // The no-card trial belongs to start_trial(). Checkout is an explicit paid conversion.
    ...(!oneTime ? { subscription_data: { metadata: { user_id: ctx.user.id } } } : {}),
    ...(influencer ? { discounts: [{ coupon: COUPON_50_PERCENT }] } : {}),
  };
  const idempotencyKey = await billingKey(`checkout-v1:${ctx.user.id}:${requestId}`);
  ctx.check();
  const session = await ctx.stripe.checkout.sessions.create(params, { idempotencyKey });
  ctx.check();
  return billingJson({ url: stripeRedirect(session.url, "checkout.stripe.com"), hasDiscount: !!influencer, influencerName: influencer?.beneficiary_name ?? null });
}));
