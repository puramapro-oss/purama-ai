import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.91.0";
import { applyOveragePayment } from "./overage.ts";
import {
  normalizeStripeReconciliationEvent,
  persistStripeReconciliationEvent,
} from "../_shared/stripe-reconciliation.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[STRIPE-WEBHOOK] ${step}${detailsStr}`);
};

// Map Stripe product IDs vers les PlanId réels de src/lib/plans.ts (1 seule source de vérité —
// ERRORS.md 2026-07-27 : l'ancien mapping pointait vers des produits Stripe différents de ceux
// utilisés par le checkout réel, et 'premium'/'enterprise' ne correspondaient à AUCUNE clé de PLANS,
// ce qui faisait silencieusement retomber tout abonné payant sur le quota Découverte/Free).
const planMapping: Record<string, string> = {
  "prod_UHwPcnEEVEDf4K": "starter",
  "prod_UHwPSU2o4DW6Ej": "pro", // "Premium" (nom affiché) = PlanId 'pro'
  "prod_UHwPBOGTleT37J": "ultime",
};

type SubscriptionOwner = { user_id: string; stripe_customer_id: string | null };

function stripeId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (
    value && typeof value === "object" && "id" in value &&
    typeof value.id === "string"
  ) return value.id;
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 405,
    });
  }

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!stripeKey || !webhookSecret || !supabaseUrl || !supabaseServiceKey) {
    logStep("ERROR: Missing environment variables");
    return new Response(
      JSON.stringify({ error: "Server configuration error" }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 503,
      },
    );
  }

  // httpClient explicite requis en environnement Deno/edge (cf ERRORS.md 2026-07-27)
  const stripe = new Stripe(stripeKey, {
    apiVersion: "2025-08-27.basil",
    httpClient: Stripe.createFetchHttpClient(),
    timeout: 10_000,
  });

  const supabaseClient = createClient(
    supabaseUrl,
    supabaseServiceKey,
    { db: { schema: "purama_ai" }, auth: { persistSession: false } },
  );

  try {
    const signature = req.headers.get("stripe-signature");
    if (!signature) {
      logStep("ERROR: No Stripe signature found");
      return new Response(JSON.stringify({ error: "No signature" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    const body = await req.text();
    let event: Stripe.Event;

    try {
      event = await stripe.webhooks.constructEventAsync(
        body,
        signature,
        webhookSecret,
        undefined,
        Stripe.createSubtleCryptoProvider(),
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logStep("ERROR: Webhook signature verification failed", {
        error: errorMessage,
      });
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    logStep("Event received", { type: event.type, id: event.id });

    // Acknowledge financial events only after durable, authenticated evidence has
    // been recorded. This journal confers no commission or permission to transfer.
    // Database failures and conflicting replays must make Stripe retry (non-2xx).
    const observation = normalizeStripeReconciliationEvent(event);
    const receipt = observation
      ? await persistStripeReconciliationEvent(supabaseClient, observation)
      : null;

    // The legacy subscription table belongs to the platform account. There is
    // no connected-account/customer mapping here. Keep the facts without ever
    // retrieving an acct_* object with the platform's credentials or mutating
    // platform subscriptions on its behalf.
    const configuredLiveMode = /^(sk|rk)_live_/.test(stripeKey)
      ? true
      : /^(sk|rk)_test_/.test(stripeKey)
      ? false
      : null;
    if (
      event.account ||
      (configuredLiveMode !== null && event.livemode !== configuredLiveMode)
    ) {
      return new Response(
        JSON.stringify({
          received: true,
          ...(receipt ?? {}),
          application: "deferred",
          reason: event.account
            ? "connected_account_not_mapped"
            : "provider_mode_mismatch",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200,
        },
      );
    }

    // Read the current provider object for every subscription application. A
    // delayed webhook must not replay an old status after a newer payment. The
    // legacy table still has no subscription_id/version: multiple subscriptions
    // for one customer need the canonical engine's reconciliation.
    const syncSubscription = async (
      subscriptionId: string,
      checkout?: Stripe.Checkout.Session,
    ) => {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const customerId = stripeId(subscription.customer);
      const checkoutCustomerId = checkout ? stripeId(checkout.customer) : null;
      if (!customerId || (checkout && checkoutCustomerId !== customerId)) {
        throw new Error(
          "Subscription customer identity is missing or inconsistent",
        );
      }
      const subscriptionUserId = subscription.metadata?.user_id || null;
      const checkoutUserId = checkout?.metadata?.user_id || null;
      if (
        subscriptionUserId && checkoutUserId &&
        subscriptionUserId !== checkoutUserId
      ) {
        throw new Error("Conflicting server user attribution");
      }
      const userId = checkoutUserId || subscriptionUserId;
      const { data: byCustomer, error: customerError } = await supabaseClient
        .from("subscriptions")
        .select("user_id, stripe_customer_id")
        .eq("stripe_customer_id", customerId)
        .maybeSingle();
      if (customerError) throw new Error("Subscription customer lookup failed");

      let owner: SubscriptionOwner | null = byCustomer;
      if (userId) {
        const { data: byUser, error: userError } = await supabaseClient
          .from("subscriptions")
          .select("user_id, stripe_customer_id")
          .eq("user_id", userId)
          .maybeSingle();
        if (userError) throw new Error("Subscription user lookup failed");
        if (
          !byUser || (byCustomer && byCustomer.user_id !== userId) ||
          (byUser.stripe_customer_id &&
            byUser.stripe_customer_id !== customerId)
        ) {
          throw new Error(
            "Subscription customer does not match the attributed user",
          );
        }
        owner = byUser;
      }
      if (!owner) {
        throw new Error("Subscription has no stable user/customer binding");
      }

      const items = subscription.items.data;
      const productId = items.length === 1 && !subscription.items.has_more
        ? stripeId(items[0].price.product)
        : null;
      const planType = productId ? planMapping[productId] : undefined;
      if (!planType) {
        throw new Error(
          "Unknown or ambiguous subscription product; reconciliation required",
        );
      }
      const status = subscription.status;
      if (
        ![
          "active",
          "trialing",
          "past_due",
          "unpaid",
          "canceled",
          "incomplete",
          "incomplete_expired",
          "paused",
        ].includes(status)
      ) {
        throw new Error("Unknown subscription status; reconciliation required");
      }

      // Compare the previous binding as well as user_id: concurrent replacement
      // of a customer must fail visibly instead of overwriting another binding.
      let update = supabaseClient.from("subscriptions").update({
        plan_type: status === "canceled" ? "free" : planType,
        status,
        stripe_customer_id: customerId,
        updated_at: new Date().toISOString(),
      }).eq("user_id", owner.user_id);
      update = owner.stripe_customer_id
        ? update.eq("stripe_customer_id", owner.stripe_customer_id)
        : update.is("stripe_customer_id", null);
      const { data: updated, error: updateError } = await update.select(
        "user_id",
      ).single();
      if (updateError || !updated || updated.user_id !== owner.user_id) {
        throw new Error("Subscription update was not confirmed");
      }
      logStep("Subscription synchronized", {
        userId: owner.user_id,
        planType,
        status,
      });
    };

    // Handle the event
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object as Stripe.Checkout.Session;
        logStep("Checkout session completed", {
          sessionId: session.id,
          customerId: session.customer,
        });

        if (session.mode === "subscription") {
          const subscriptionId = stripeId(session.subscription);
          if (!subscriptionId) {
            throw new Error("Checkout has no valid subscription reference");
          }
          await syncSubscription(subscriptionId, session);
        } else {
          // Keep one canonical writer for legacy packs. Signed payment evidence
          // is validated after the journal receipt, and the existing SQL function
          // preserves the original month and rejects conflicting session proof.
          const result = await applyOveragePayment(
            event,
            2000,
            (parameters) =>
              supabaseClient.rpc("credit_overage_pack", parameters),
          );
          if (result.status !== "ignored") {
            logStep("Overage payment processed", {
              sessionId: session.id,
              status: result.status,
              periodStart: result.periodStart,
            });
          }
        }
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscriptionId = stripeId(event.data.object);
        if (!subscriptionId) throw new Error("Missing subscription identity");
        await syncSubscription(subscriptionId);
        break;
      }

      case "invoice.payment_failed": {
        // A one-off invoice must not downgrade a subscription merely because it
        // shares a customer. Read a proven subscription reference (legacy/Basil)
        // and synchronize its current provider state instead of forcing past_due.
        const subscriptionId = observation?.source_facts.subscription_id;
        if (typeof subscriptionId === "string") {
          await syncSubscription(subscriptionId);
        }
        break;
      }

      case "invoice.paid":
      case "invoice.payment_succeeded": {
        // Initial and recurring invoices are durably recorded above. Do not validate
        // an old annual estimate after one payment, or invent a new recurring right.
        break;
      }

      default:
        logStep("Unhandled event type", { type: event.type });
    }

    return new Response(
      JSON.stringify({ received: true, ...(receipt ?? {}) }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      },
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR in stripe-webhook", { message: errorMessage });
    return new Response(
      JSON.stringify({
        error: "Webhook processing failed; event not acknowledged",
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 503,
      },
    );
  }
});
