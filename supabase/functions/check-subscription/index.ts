import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.91.0";
import { resolveStripeSubscriptionState } from "../_shared/stripe-subscription-state.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CHECK-SUBSCRIPTION] ${step}${detailsStr}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { db: { schema: 'purama_ai' }, auth: { persistSession: false } }
  );

  try {
    logStep("Function started");

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");
    logStep("Stripe key verified");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");
    logStep("Authorization header found");

    const token = authHeader.replace("Bearer ", "");
    logStep("Authenticating user with token");
    
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user?.email) throw new Error("User not authenticated or email not available");
    logStep("User authenticated", { userId: user.id, email: user.email });

    // httpClient explicite requis en environnement Deno/edge (le client Node par défaut de Stripe
    // ne fonctionne pas sous Deno et bloque indéfiniment la requête sans jamais lever d'erreur —
    // cf ERRORS.md 2026-07-27, découvert car check-subscription/create-checkout ne répondaient
    // jamais en prod, empêchant TOUT paiement réel depuis toujours).
    const stripe = new Stripe(stripeKey, {
      apiVersion: "2025-08-27.basil",
      httpClient: Stripe.createFetchHttpClient(),
      timeout: 10_000,
    });
    const customers = await stripe.customers.list({ email: user.email, limit: 2 });

    // Email is not a unique Stripe customer key. Do not silently select one account.
    if (customers.data.length > 1 || customers.has_more) {
      logStep("Multiple Stripe customers require reconciliation");
      return new Response(JSON.stringify({
        error: 'État de facturation à vérifier. Aucun nouveau droit accordé.',
        code: 'SUBSCRIPTION_RECONCILIATION_REQUIRED',
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 409 });
    }
    
    if (customers.data.length === 0) {
      logStep("No customer found, returning unsubscribed state");
      return new Response(JSON.stringify({ 
        subscribed: false,
        plan_type: 'free',
        product_id: null,
        subscription_end: null
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const customerId = customers.data[0].id;
    logStep("Found Stripe customer", { customerId });

    // Check for active OR trialing subscriptions
    const activeSubscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "active",
      limit: 2,
    });

    const trialingSubscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "trialing",
      limit: 2,
    });

    const allSubscriptions = [...activeSubscriptions.data, ...trialingSubscriptions.data];
    const resolution = resolveStripeSubscriptionState(allSubscriptions);
    if (resolution.status !== 'ready') {
      logStep("Subscription requires reconciliation", { reason: resolution.reason });
      return new Response(JSON.stringify({
        error: 'État de facturation à vérifier. Aucun nouveau droit accordé.',
        code: 'SUBSCRIPTION_RECONCILIATION_REQUIRED',
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 409 });
    }

    return new Response(JSON.stringify(resolution.state), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR in check-subscription", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
