import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.91.0";
import { applyOveragePayment } from "./overage.ts";
import { normalizeStripeReconciliationEvent, persistStripeReconciliationEvent } from "../_shared/stripe-reconciliation.ts";
import { readRequestText, RequestBodyError } from "../_shared/request-body.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[STRIPE-WEBHOOK] ${step}${detailsStr}`);
};

// Map Stripe product IDs vers les PlanId réels de src/lib/plans.ts (1 seule source de vérité —
// ERRORS.md 2026-07-27 : l'ancien mapping pointait vers des produits Stripe différents de ceux
// utilisés par le checkout réel, et 'premium'/'enterprise' ne correspondaient à AUCUNE clé de PLANS,
// ce qui faisait silencieusement retomber tout abonné payant sur le quota Découverte/Free).
const planMapping: Record<string, string> = {
  'prod_UHwPcnEEVEDf4K': 'starter',
  'prod_UHwPSU2o4DW6Ej': 'pro', // "Premium" (nom affiché) = PlanId 'pro'
  'prod_UHwPBOGTleT37J': 'ultime',
};

// This checkout sells one known subscription plan. Unknown, deleted, expanded
// or ambiguous products must never fall through to a paid default plan.
function subscriptionPlan(subscription: Stripe.Subscription): { productId: string; planType: string } {
  const items = subscription.items;
  if (!items || items.has_more === true || !Array.isArray(items.data) || items.data.length !== 1) {
    throw new Error('Subscription plan requires reconciliation');
  }
  const productId = stripeObjectId(items.data[0]?.price?.product);
  if (!productId || !Object.prototype.hasOwnProperty.call(planMapping, productId)) {
    throw new Error('Subscription product requires reconciliation');
  }
  return { productId, planType: planMapping[productId] };
}

async function confirmedSubscriptionState(subscription: Stripe.Subscription, stripe: Stripe): Promise<{
  status: string; trial_ends_at?: string; has_used_trial?: true;
}> {
  if (subscription.status === 'trialing') {
    const seconds = subscription.trial_end;
    if (!Number.isSafeInteger(seconds) || seconds === null || seconds <= Math.floor(Date.now() / 1000)
      || seconds > 253402300799) throw new Error('Subscription trial requires reconciliation');
    // Preserve existing Stripe trials at their fixed provider deadline. A
    // redelivery cannot restart or extend the application's one-time trial.
    return { status: 'trialing', trial_ends_at: new Date(seconds * 1000).toISOString(), has_used_trial: true };
  }
  if (subscription.status === 'active') {
    // Stripe can report active for send_invoice before payment. Require the
    // current invoice's paid status instead of treating active as proof of funds.
    const invoiceId = stripeObjectId(subscription.latest_invoice);
    if (!invoiceId) throw new Error('Subscription payment requires reconciliation');
    const invoice = await stripe.invoices.retrieve(invoiceId);
    if (invoice.id !== invoiceId || invoice.status !== 'paid'
      || !stripeObjectId(invoice.customer)
      || stripeObjectId(invoice.customer) !== stripeObjectId(subscription.customer)) {
      throw new Error('Subscription payment requires reconciliation');
    }
  }
  return { status: subscription.status };
}

type SubscriptionLink = {
  id: string; user_id: string; stripe_customer_id: string | null;
  stripe_subscription_id: string | null; revision: number;
};
// Infer the concrete purama_ai client. ReturnType of the generic createClient
// erases its database/schema inference and narrows queried rows to never.
function createSubscriptionClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { db: { schema: 'purama_ai' }, auth: { persistSession: false } }
  );
}
type SubscriptionClient = ReturnType<typeof createSubscriptionClient>;

async function storedSubscription(
  client: SubscriptionClient, column: 'stripe_customer_id' | 'user_id', value: string,
): Promise<SubscriptionLink | null> {
  // Do not use limit(1): multiple matching rows require reconciliation.
  const { data, error } = await client.from('subscriptions')
    .select('id,user_id,stripe_customer_id,stripe_subscription_id,revision').eq(column, value).maybeSingle();
  if (error) throw new Error('Subscription identity lookup failed; retry or reconcile');
  if (!data) return null;
  if (typeof data.id !== 'string' || !data.id || typeof data.user_id !== 'string' || !data.user_id
    || (data.stripe_customer_id !== null && typeof data.stripe_customer_id !== 'string')
    || (data.stripe_subscription_id !== null && stripeObjectId(data.stripe_subscription_id, 'sub') !== data.stripe_subscription_id)
    || !Number.isSafeInteger(data.revision) || data.revision < 0
    || data[column] !== value) throw new Error('Subscription identity requires reconciliation');
  return data;
}

async function persistSubscription(
  client: SubscriptionClient, link: SubscriptionLink, patch: Record<string, unknown>,
): Promise<void> {
  // The snapshot precedes provider reads. The database advances revision for
  // every writer, including local trials, even when updated_at is unchanged.
  let query = client.from('subscriptions').update(patch)
    .eq('id', link.id).eq('user_id', link.user_id).eq('revision', link.revision);
  query = link.stripe_customer_id === null
    ? query.is('stripe_customer_id', null) : query.eq('stripe_customer_id', link.stripe_customer_id);
  query = link.stripe_subscription_id === null
    ? query.is('stripe_subscription_id', null) : query.eq('stripe_subscription_id', link.stripe_subscription_id);
  const { data, error } = await query.select('id,user_id,stripe_customer_id,stripe_subscription_id,revision,plan_type,status').single();
  const expectedCustomer = patch.stripe_customer_id ?? link.stripe_customer_id;
  const expectedSubscription = patch.stripe_subscription_id ?? link.stripe_subscription_id;
  if (error || !data || data.id !== link.id || data.user_id !== link.user_id
    || data.stripe_customer_id !== expectedCustomer || data.stripe_subscription_id !== expectedSubscription
    || !Number.isSafeInteger(data.revision) || data.revision !== link.revision + 1
    || data.plan_type !== patch.plan_type || data.status !== patch.status) {
    throw new Error('Subscription persistence failed; retry before further effects');
  }
}

// Taille du pack de dépassement — cf OVERAGE_PACK.actions dans src/lib/plans.ts (1 seule source de
// vérité déclarée ; dupliquée ici car cette fonction Deno n'importe pas src/lib).
const OVERAGE_PACK_ACTIONS = 2000;

const subscriptionColumns = 'id,user_id,stripe_customer_id,stripe_subscription_id,revision,plan_type,status,trial_ends_at,has_used_trial,updated_at';
type SubscriptionRow = SubscriptionLink & {
  plan_type: string;
  status: string;
  trial_ends_at: string | null;
  has_used_trial: boolean;
  updated_at: string | null;
};

// Existing update/invoice consumers keep their optional-id contract; checkout
// admission additionally requires the expected Stripe object prefix.
function stripeObjectId(value: unknown): string | undefined;
function stripeObjectId(value: unknown, prefix: string): string;
function stripeObjectId(value: unknown, prefix?: string): string | undefined {
  let candidate: unknown;
  if (typeof value === 'string' && value) candidate = value;
  else if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
    && !('deleted' in value && value.deleted === true)) candidate = value.id;
  if (prefix === undefined) return typeof candidate === 'string' ? candidate : undefined;
  if (typeof candidate !== 'string' || candidate.length > 255 || !new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(candidate)) {
    throw new Error('checkout_identity_invalid');
  }
  return candidate;
}

function checkoutUserId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('checkout_user_invalid');
  }
  return value.toLowerCase();
}

function subscriptionRow(data: unknown, error: unknown): SubscriptionRow | undefined {
  if (error || !Array.isArray(data) || data.length > 1) throw new Error('checkout_subscription_lookup_failed');
  const row = data[0];
  if (row && (typeof row !== 'object' || checkoutUserId(row.user_id) !== row.user_id
    || typeof row.id !== 'string' || !row.id
    || typeof row.has_used_trial !== 'boolean'
    || typeof row.plan_type !== 'string' || typeof row.status !== 'string'
    || (row.stripe_customer_id !== null && typeof row.stripe_customer_id !== 'string')
    || (row.stripe_subscription_id !== null && stripeObjectId(row.stripe_subscription_id, 'sub') !== row.stripe_subscription_id)
    || !Number.isSafeInteger(row.revision) || row.revision < 0
    || (row.trial_ends_at !== null && typeof row.trial_ends_at !== 'string')
    || (row.updated_at !== null && typeof row.updated_at !== 'string'))) {
    throw new Error('checkout_subscription_record_invalid');
  }
  return row;
}

/** Only called after signature verification. Email is never an ownership proof. */
async function completeSubscriptionCheckout(
  session: Stripe.Checkout.Session,
  stripe: Stripe,
  database: SubscriptionClient,
) {
  stripeObjectId(session, 'cs');
  const customerId = stripeObjectId(session.customer, 'cus');
  const subscriptionId = stripeObjectId(session.subscription, 'sub');
  if (session.status !== 'complete' || typeof session.livemode !== 'boolean') {
    throw new Error('checkout_session_invalid');
  }
  // Delayed payment methods emit a separate successful event. A completed form
  // alone must never grant paid rights, even if another provider read is active.
  if (session.payment_status === 'unpaid') return undefined;
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') throw new Error('checkout_payment_invalid');

  // Capture the local identity/version before any provider observation. Reading
  // it after Stripe would let an old paid response capture a newer cancellation
  // and overwrite it with a CAS that only appears to protect concurrency.
  const linkedResult = await database.from('subscriptions').select(subscriptionColumns)
    .eq('stripe_customer_id', customerId).limit(2);
  const linked = subscriptionRow(linkedResult.data, linkedResult.error);
  // Legacy sessions without server user metadata still require a unique
  // database binding. Customer email is never an ownership proof.
  const userId = checkoutUserId(session.metadata?.user_id ?? linked?.user_id);
  const existingResult = await database.from('subscriptions').select(subscriptionColumns).eq('user_id', userId).limit(2);
  const existing = subscriptionRow(existingResult.data, existingResult.error);
  if ((existing && existing.stripe_customer_id !== null && existing.stripe_customer_id !== customerId)
    || (linked && (!existing || existing.id !== linked.id || existing.stripe_customer_id !== customerId))) {
    throw new Error('checkout_customer_binding_conflict');
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const customer = await stripe.customers.retrieve(customerId);
  if (stripeObjectId(subscription, 'sub') !== subscriptionId
    || stripeObjectId(subscription.customer, 'cus') !== customerId
    || stripeObjectId(customer, 'cus') !== customerId || customer.deleted
    || subscription.livemode !== session.livemode || customer.livemode !== session.livemode) {
    throw new Error('checkout_provider_identity_conflict');
  }
  if (subscription.status !== 'active' && subscription.status !== 'trialing') {
    throw new Error('checkout_subscription_not_ready');
  }
  const items = subscription.items;
  if (items.has_more !== false || items.data.length !== 1) throw new Error('checkout_subscription_items_ambiguous');
  const productId = stripeObjectId(items.data[0].price.product, 'prod');
  const planType = planMapping[productId];
  if (!planType) throw new Error('checkout_product_unknown');

  // Keep the newer provider proof from PR40: active is not payment evidence.
  // Even a discounted checkout must re-read its current paid invoice.
  const confirmedState = await confirmedSubscriptionState(subscription, stripe);

  // A stale checkout must not choose between multiple open subscriptions.
  const page = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
  if (page.has_more !== false || !Array.isArray(page.data)) throw new Error('checkout_subscription_list_incomplete');
  const open = page.data.filter((entry: Stripe.Subscription) => !['canceled', 'incomplete_expired'].includes(entry.status));
  if (open.length !== 1 || open[0].id !== subscriptionId || open[0].status !== subscription.status
    || stripeObjectId(open[0].customer, 'cus') !== customerId) {
    throw new Error('checkout_subscriptions_ambiguous');
  }

  for (const candidate of [subscription.metadata?.user_id, customer.metadata?.user_id, session.client_reference_id]) {
    if (candidate != null && checkoutUserId(candidate) !== userId) throw new Error('checkout_user_conflict');
  }
  if ((linked && linked.user_id !== userId) || (!linked && customer.metadata?.user_id !== userId)) {
    throw new Error('checkout_customer_unowned');
  }
  const { data: userData, error: userError } = await database.auth.admin.getUserById(userId);
  if (userError || userData?.user?.id !== userId) throw new Error('checkout_user_not_found');
  const user = userData.user;

  const trialEndsAt = confirmedState.trial_ends_at ?? existing?.trial_ends_at ?? null;
  const usedTrial = existing?.has_used_trial === true || confirmedState.has_used_trial === true || subscription.trial_start != null;
  // PostgREST can serialize the same timestamptz as +00:00 rather than .000Z.
  const sameTrialEnd = (value: string | null) => value === trialEndsAt || (value !== null && trialEndsAt !== null
    && Number.isFinite(Date.parse(value)) && Date.parse(value) === Date.parse(trialEndsAt));
  const matches = (row: SubscriptionRow) => row.user_id === userId && row.stripe_customer_id === customerId
    && row.stripe_subscription_id === subscriptionId
    && row.plan_type === planType && row.status === confirmedState.status
    && sameTrialEnd(row.trial_ends_at) && (!usedTrial || row.has_used_trial === true);
  if (existing && matches(existing)) {
    // A paid confirmation still fences older provider observations. Touch only
    // the version/timestamp, not the rights: a read-only no-op would let an older
    // past-due delivery overwrite this more recent confirmation afterwards.
    const currentResult = await database.from('subscriptions').update({ updated_at: new Date().toISOString() })
      .eq('id', existing.id).eq('user_id', userId).eq('revision', existing.revision)
      .eq('stripe_customer_id', customerId).eq('stripe_subscription_id', subscriptionId)
      .select(subscriptionColumns);
    const current = subscriptionRow(currentResult.data, currentResult.error);
    if (!current || current.id !== existing.id || !matches(current) || current.revision !== existing.revision + 1) {
      throw new Error('checkout_subscription_changed_during_confirmation');
    }
    return { user, planType, subscriptionId, applied: false };
  }

  const values = {
    plan_type: planType,
    ...confirmedState,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    ...(subscription.status === 'trialing' ? { trial_ends_at: trialEndsAt } : {}),
    // Never write false: a concurrent local trial must remain consumed.
    ...(usedTrial ? { has_used_trial: true } : {}),
    updated_at: new Date().toISOString(),
  };
  let result;
  if (existing) {
    let update = database.from('subscriptions').update(values).eq('id', existing.id)
      .eq('user_id', userId).eq('revision', existing.revision)
      .eq('plan_type', existing.plan_type).eq('status', existing.status);
    update = existing.stripe_customer_id === null ? update.is('stripe_customer_id', null) : update.eq('stripe_customer_id', existing.stripe_customer_id);
    update = existing.stripe_subscription_id === null ? update.is('stripe_subscription_id', null) : update.eq('stripe_subscription_id', existing.stripe_subscription_id);
    update = existing.updated_at === null ? update.is('updated_at', null) : update.eq('updated_at', existing.updated_at);
    result = await update.select(subscriptionColumns);
  } else {
    // UNIQUE(user_id) arbitrates concurrent first deliveries. A losing insert
    // is retried by Stripe; it is not acknowledged as a successful activation.
    result = await database.from('subscriptions').insert({ user_id: userId, ...values }).select(subscriptionColumns);
  }
  const persisted = subscriptionRow(result.data, result.error);
  if (!persisted || !matches(persisted)
    || persisted.revision !== (existing ? existing.revision + 1 : 0)
    || (existing && persisted.id !== existing.id)) throw new Error('checkout_subscription_write_unconfirmed');
  return { user, planType, subscriptionId, applied: true };
}

async function synchronizeCurrentSubscription(
  subscriptionId: string, stripe: Stripe, database: SubscriptionClient,
  livemode: boolean, expectedCustomerId: string,
): Promise<void> {
  stripeObjectId(subscriptionId, 'sub');
  const customerId = stripeObjectId(expectedCustomerId, 'cus');
  // A signed event supplies the lookup key, not the current state. Capture the
  // local row first and only then reread the provider under that revision.
  const link = await storedSubscription(database, 'stripe_customer_id', customerId);
  if (!link) throw new Error('Subscription customer binding requires reconciliation');
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (stripeObjectId(subscription, 'sub') !== subscriptionId || subscription.livemode !== livemode
    || stripeObjectId(subscription.customer, 'cus') !== customerId) {
    throw new Error('Subscription provider identity requires reconciliation');
  }
  if (!['active', 'trialing', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused'].includes(subscription.status)) {
    throw new Error('Subscription status requires reconciliation');
  }
  const { planType } = subscriptionPlan(subscription);
  const page = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
  if (page.has_more !== false || !Array.isArray(page.data)
    || !page.data.some((entry: Stripe.Subscription) => entry.id === subscriptionId)) {
    throw new Error('Subscription list requires reconciliation');
  }
  const terminal = ['canceled', 'incomplete_expired'].includes(subscription.status);
  const open = page.data.filter((entry: Stripe.Subscription) => !['canceled', 'incomplete_expired'].includes(entry.status));
  // A state that grants no rights may change only its confirmed binding. A
  // local trial has no Stripe identity: an old past-due/paused subscription must
  // not adopt it any more than an old cancellation. New identities are accepted
  // only after the active-payment or trial proof checked below.
  if (link.stripe_subscription_id !== subscriptionId && !['active', 'trialing'].includes(subscription.status)) {
    throw new Error('Subscription state identity requires reconciliation');
  }
  if (terminal ? open.length !== 0 : open.length !== 1 || open[0].id !== subscriptionId
    || open[0].status !== subscription.status || stripeObjectId(open[0].customer, 'cus') !== customerId) {
    throw new Error('Subscription selection requires reconciliation');
  }
  const confirmedState = await confirmedSubscriptionState(subscription, stripe);
  if (subscription.metadata?.user_id != null && checkoutUserId(subscription.metadata.user_id) !== link.user_id) {
    throw new Error('Subscription customer binding requires reconciliation');
  }
  await persistSubscription(database, link, {
    plan_type: subscription.status === 'canceled' ? 'free' : planType,
    stripe_subscription_id: subscriptionId,
    ...confirmedState,
    updated_at: new Date().toISOString(),
  });
  logStep('Current subscription synchronized', { userId: link.user_id, planType, status: confirmedState.status });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 405,
    });
  }

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const configuredLiveMode = /^(sk|rk)_live_/.test(stripeKey ?? '') ? true
    : /^(sk|rk)_test_/.test(stripeKey ?? '') ? false : null;
  
  if (!stripeKey || configuredLiveMode === null || !webhookSecret
    || !Deno.env.get("SUPABASE_URL") || !Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
    logStep("ERROR: Missing or invalid server configuration");
    return new Response(JSON.stringify({ error: "Server configuration error" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 503,
    });
  }

  // httpClient explicite requis en environnement Deno/edge (cf ERRORS.md 2026-07-27)
  const stripe = new Stripe(stripeKey, {
    apiVersion: "2025-08-27.basil",
    httpClient: Stripe.createFetchHttpClient(),
    timeout: 10_000,
    maxNetworkRetries: 0,
  });
  
  const supabaseClient = createSubscriptionClient();

  try {
    const signature = req.headers.get("stripe-signature");
    if (!signature) {
      logStep("ERROR: No Stripe signature found");
      return new Response(JSON.stringify({ error: "No signature" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    // Application ingress budget, not a Stripe payload-size guarantee. Count
    // raw UTF-8 bytes before decoding and retain the exact text for the SDK.
    const body = await readRequestText(req, { maxBytes: 1024 * 1024, timeoutMs: 5_000 });
    let event: Stripe.Event;

    try {
      event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret, undefined, Stripe.createSubtleCryptoProvider());
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logStep("ERROR: Webhook signature verification failed", { error: errorMessage });
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    logStep("Event received", { type: event.type, id: event.id });

    // The signature has authenticated the original body. No application effect
    // precedes a durable journal receipt, including during retries.
    const observation = normalizeStripeReconciliationEvent(event);
    const receipt = observation ? await persistStripeReconciliationEvent(supabaseClient, observation) : null;
    if (event.account || event.livemode !== configuredLiveMode) {
      return new Response(JSON.stringify({
        received: true, ...(receipt ?? {}), application: 'deferred',
        reason: event.account ? 'connected_account_not_mapped' : 'provider_mode_mismatch',
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });
    }

    // Handle the event
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object as Stripe.Checkout.Session;
        logStep("Checkout session received", { sessionId: session.id });

        if (session.mode === 'subscription') {
          if (session.livemode !== event.livemode) throw new Error('checkout_event_mode_conflict');
          if (event.type === 'checkout.session.async_payment_succeeded' && session.payment_status !== 'paid') {
            throw new Error('checkout_async_payment_not_confirmed');
          }
          const activation = await completeSubscriptionCheckout(session, stripe, supabaseClient);
          if (!activation) {
            logStep("Checkout awaiting payment", { sessionId: session.id });
            break;
          }
          const { user, planType, subscriptionId, applied } = activation;
          logStep("Subscription checkout processed", { userId: user.id, planType, applied });

        } else if (session.mode === 'payment' && session.metadata?.type === 'overage_pack') {
          const result = await applyOveragePayment(event, OVERAGE_PACK_ACTIONS,
            parameters => supabaseClient.rpc('credit_overage_pack', parameters));
          logStep("Overage payment processed", { sessionId: session.id, ...result });
        }
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const received = event.data.object as Stripe.Subscription;
        await synchronizeCurrentSubscription(received.id, stripe, supabaseClient, event.livemode, stripeObjectId(received.customer, 'cus'));
        break;
      }

      case 'invoice.payment_failed': {
        // A one-off invoice is evidence, not a subscription downgrade. For a
        // linked invoice re-read current Stripe state, keeping PR40's paid proof.
        const subscriptionId = observation?.source_facts.subscription_id;
        if (typeof subscriptionId === 'string') {
          const customerId = observation?.source_facts.customer_id;
          if (typeof customerId !== 'string') throw new Error('Invoice customer requires reconciliation');
          await synchronizeCurrentSubscription(subscriptionId, stripe, supabaseClient, event.livemode, customerId);
        }
        break;
      }

      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        // Durable observations do not validate historical annual estimates or
        // create new commissions. Settlement needs an explicit commerce policy.
        break;
      }

      default:
        logStep("Unhandled event type", { type: event.type });
    }

    return new Response(JSON.stringify({ received: true, ...(receipt ?? {}) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return new Response(JSON.stringify({ error: error.message }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: error.status,
      });
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR in stripe-webhook", { message: errorMessage });
    return new Response(JSON.stringify({ error: "Webhook processing failed; event not acknowledged" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 503,
    });
  }
});
