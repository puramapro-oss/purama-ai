import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.91.0";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { applyOveragePayment } from "./overage.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[STRIPE-WEBHOOK] ${step}${detailsStr}`);
};

// Generate commission email HTML
function generateCommissionEmailHtml(data: {
  beneficiaryName: string;
  commissionAmount: number;
  saleAmount: number;
  promoCode: string;
  planType: string;
}): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nouvelle commission Agentia</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #0a0a0f;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #0a0a0f;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%); border-radius: 16px; border: 1px solid rgba(255,255,255,0.1);">
          <!-- Header -->
          <tr>
            <td style="padding: 32px 32px 24px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td>
                    <span style="font-size: 24px; font-weight: bold; background: linear-gradient(135deg, #00d4ff, #a855f7); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">
                      Agentia
                    </span>
                  </td>
                  <td align="right">
                    <span style="display: inline-block; padding: 6px 12px; background-color: #22c55e22; color: #22c55e; border-radius: 20px; font-size: 12px; font-weight: 600;">
                      💰 Nouvelle commission
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 0 32px 32px;">
              <h1 style="margin: 0 0 16px; font-size: 28px; font-weight: 600; color: #ffffff;">
                Félicitations ${data.beneficiaryName} ! 🎉
              </h1>
              <p style="margin: 0 0 24px; font-size: 18px; line-height: 1.6; color: #a1a1aa;">
                Vous avez généré une nouvelle vente grâce à votre code <strong style="color: #00d4ff;">${data.promoCode}</strong> !
              </p>
              
              <!-- Stats Box -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background: rgba(34, 197, 94, 0.1); border-radius: 12px; border: 1px solid rgba(34, 197, 94, 0.3); margin-bottom: 24px;">
                <tr>
                  <td style="padding: 24px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td width="50%" style="padding-right: 12px;">
                          <p style="margin: 0 0 4px; font-size: 12px; color: #71717a; text-transform: uppercase; letter-spacing: 1px;">Commission gagnée</p>
                          <p style="margin: 0; font-size: 32px; font-weight: bold; color: #22c55e;">+${data.commissionAmount.toFixed(2)}€</p>
                        </td>
                        <td width="50%" style="padding-left: 12px; border-left: 1px solid rgba(255,255,255,0.1);">
                          <p style="margin: 0 0 4px; font-size: 12px; color: #71717a; text-transform: uppercase; letter-spacing: 1px;">Valeur de la vente</p>
                          <p style="margin: 0; font-size: 24px; font-weight: 600; color: #ffffff;">${data.saleAmount.toFixed(2)}€</p>
                          <p style="margin: 4px 0 0; font-size: 12px; color: #a1a1aa;">Abonnement ${data.planType}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              
              <p style="margin: 0 0 24px; font-size: 14px; line-height: 1.6; color: #71717a;">
                Cette commission est actuellement en attente de validation. Une fois le premier paiement confirmé, elle sera validée et ajoutée à votre prochain versement.
              </p>
              
              <a href="https://purama-ai.purama.dev/influenceur/dashboard" style="display: inline-block; padding: 14px 28px; background: linear-gradient(135deg, #00d4ff, #a855f7); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">
                Voir mon tableau de bord →
              </a>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 32px; border-top: 1px solid rgba(255,255,255,0.1);">
              <p style="margin: 0; font-size: 12px; color: #71717a; text-align: center;">
                Merci d'être partenaire Agentia !<br>
                <a href="https://purama-ai.purama.dev/influenceur/dashboard" style="color: #a855f7; text-decoration: none;">Gérer mon compte influenceur</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

// Map Stripe product IDs vers les PlanId réels de src/lib/plans.ts (1 seule source de vérité —
// ERRORS.md 2026-07-27 : l'ancien mapping pointait vers des produits Stripe différents de ceux
// utilisés par le checkout réel, et 'premium'/'enterprise' ne correspondaient à AUCUNE clé de PLANS,
// ce qui faisait silencieusement retomber tout abonné payant sur le quota Découverte/Free).
const planMapping: Record<string, string> = {
  'prod_UHwPcnEEVEDf4K': 'starter',
  'prod_UHwPSU2o4DW6Ej': 'pro', // "Premium" (nom affiché) = PlanId 'pro'
  'prod_UHwPBOGTleT37J': 'ultime',
};

// Plan prices for commission calculation (monthly price in EUR) — cf src/lib/plans.ts PLANS
const planPrices: Record<string, number> = {
  'starter': 33,
  'pro': 99,
  'ultime': 199,
};

// Taille du pack de dépassement — cf OVERAGE_PACK.actions dans src/lib/plans.ts (1 seule source de
// vérité déclarée ; dupliquée ici car cette fonction Deno n'importe pas src/lib).
const OVERAGE_PACK_ACTIONS = 2000;

const subscriptionColumns = 'user_id,stripe_customer_id,plan_type,status,trial_ends_at,has_used_trial,updated_at';
type SubscriptionRow = {
  user_id: string;
  stripe_customer_id: string | null;
  plan_type: string;
  status: string;
  trial_ends_at: string | null;
  has_used_trial: boolean;
  updated_at: string | null;
};

function stripeObjectId(value: unknown, prefix: string): string {
  const candidate = typeof value === 'string' ? value
    : value && typeof value === 'object' && !('deleted' in value && value.deleted === true) && 'id' in value ? value.id : null;
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
    || typeof row.has_used_trial !== 'boolean'
    || typeof row.plan_type !== 'string' || typeof row.status !== 'string'
    || (row.stripe_customer_id !== null && typeof row.stripe_customer_id !== 'string')
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
  database: ReturnType<typeof createClient>,
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
  if (!['paid', 'no_payment_required'].includes(session.payment_status)) throw new Error('checkout_payment_invalid');

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

  // A stale checkout must not choose between multiple open subscriptions.
  const page = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
  if (page.has_more !== false || !Array.isArray(page.data)) throw new Error('checkout_subscription_list_incomplete');
  const open = page.data.filter(entry => !['canceled', 'incomplete_expired'].includes(entry.status));
  if (open.length !== 1 || open[0].id !== subscriptionId || open[0].status !== subscription.status
    || stripeObjectId(open[0].customer, 'cus') !== customerId) {
    throw new Error('checkout_subscriptions_ambiguous');
  }

  const linkedResult = await database.from('subscriptions').select(subscriptionColumns)
    .eq('stripe_customer_id', customerId).limit(2);
  const linked = subscriptionRow(linkedResult.data, linkedResult.error);
  // Legacy sessions without server user metadata may use an existing, unique
  // database binding. Customer emails and paginated auth searches are excluded.
  const userId = checkoutUserId(session.metadata?.user_id ?? linked?.user_id);
  for (const candidate of [subscription.metadata?.user_id, customer.metadata?.user_id, session.client_reference_id]) {
    if (candidate != null && checkoutUserId(candidate) !== userId) throw new Error('checkout_user_conflict');
  }
  if ((linked && linked.user_id !== userId) || (!linked && customer.metadata?.user_id !== userId)) {
    throw new Error('checkout_customer_unowned');
  }
  const { data: userData, error: userError } = await database.auth.admin.getUserById(userId);
  if (userError || userData?.user?.id !== userId) throw new Error('checkout_user_not_found');
  const user = userData.user;
  const existingResult = await database.from('subscriptions').select(subscriptionColumns).eq('user_id', userId).limit(2);
  const existing = subscriptionRow(existingResult.data, existingResult.error);
  if ((existing && existing.stripe_customer_id !== null && existing.stripe_customer_id !== customerId)
    || (linked && (!existing || existing.stripe_customer_id !== customerId))) {
    throw new Error('checkout_customer_binding_conflict');
  }

  let trialEndsAt = existing?.trial_ends_at ?? null;
  if (subscription.status === 'trialing') {
    if (!Number.isSafeInteger(subscription.trial_end) || subscription.trial_end! <= Date.now() / 1000
      || subscription.trial_end! > 253402300799) throw new Error('checkout_trial_invalid');
    trialEndsAt = new Date(subscription.trial_end! * 1000).toISOString();
  }
  const usedTrial = existing?.has_used_trial === true || subscription.status === 'trialing' || subscription.trial_start != null;
  // PostgREST can serialize the same timestamptz as +00:00 rather than .000Z.
  const sameTrialEnd = (value: string | null) => value === trialEndsAt || (value !== null && trialEndsAt !== null
    && Number.isFinite(Date.parse(value)) && Date.parse(value) === Date.parse(trialEndsAt));
  const matches = (row: SubscriptionRow) => row.user_id === userId && row.stripe_customer_id === customerId
    && row.plan_type === planType && row.status === subscription.status
    && sameTrialEnd(row.trial_ends_at) && (!usedTrial || row.has_used_trial === true);
  if (existing && matches(existing)) return { user, planType, subscriptionId, applied: false };

  const values = {
    plan_type: planType,
    status: subscription.status,
    stripe_customer_id: customerId,
    ...(subscription.status === 'trialing' ? { trial_ends_at: trialEndsAt } : {}),
    // Never write false: a concurrent local trial must remain consumed.
    ...(usedTrial ? { has_used_trial: true } : {}),
    updated_at: new Date().toISOString(),
  };
  let result;
  if (existing) {
    let update = database.from('subscriptions').update(values).eq('user_id', userId)
      .eq('plan_type', existing.plan_type).eq('status', existing.status);
    update = existing.stripe_customer_id === null ? update.is('stripe_customer_id', null) : update.eq('stripe_customer_id', existing.stripe_customer_id);
    update = existing.updated_at === null ? update.is('updated_at', null) : update.eq('updated_at', existing.updated_at);
    result = await update.select(subscriptionColumns);
  } else {
    // UNIQUE(user_id) arbitrates concurrent first deliveries. A losing insert
    // is retried by Stripe; it is not acknowledged as a successful activation.
    result = await database.from('subscriptions').insert({ user_id: userId, ...values }).select(subscriptionColumns);
  }
  const persisted = subscriptionRow(result.data, result.error);
  if (!persisted || !matches(persisted)) throw new Error('checkout_subscription_write_unconfirmed');
  return { user, planType, subscriptionId, applied: true };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  
  if (!stripeKey || !webhookSecret) {
    logStep("ERROR: Missing environment variables");
    return new Response(JSON.stringify({ error: "Server configuration error" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }

  // httpClient explicite requis en environnement Deno/edge (cf ERRORS.md 2026-07-27)
  const stripe = new Stripe(stripeKey, {
    apiVersion: "2025-08-27.basil",
    httpClient: Stripe.createFetchHttpClient(),
    timeout: 10_000,
    maxNetworkRetries: 0,
  });
  
  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { db: { schema: 'purama_ai' }, auth: { persistSession: false } }
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

          // Extract influencer info from metadata
          const referralCode = session.metadata?.referral_code;
          const influencerId = session.metadata?.influencer_id;

              // Handle influencer commission if referral was used
              // Legacy commission effects remain outside entitlement idempotency.
              // They require a separate durable receipt/transaction migration.
              if (influencerId && referralCode) {
                logStep("Processing influencer commission", { influencerId, referralCode });

                // Get influencer data
                const { data: influencer } = await supabaseClient
                  .from('influencers')
                  .select('*')
                  .eq('id', influencerId)
                  .single();

                if (influencer) {
                  // Calculate commission (annual subscription value * commission rate)
                  const monthlyPrice = planPrices[planType] || 99;
                  const annualValue = monthlyPrice * 12;
                  const commissionRate = influencer.commission_rate / 100;
                  const commissionAmount = annualValue * commissionRate;

                  logStep("Commission calculation", { 
                    monthlyPrice, 
                    annualValue, 
                    commissionRate,
                    commissionAmount 
                  });

                  // Create commission record
                  const { error: commissionError } = await supabaseClient
                    .from('commissions')
                    .insert({
                      influencer_id: influencerId,
                      client_id: user.id,
                      sale_amount: annualValue,
                      commission_amount: commissionAmount,
                      status: 'pending',
                      subscription_id: subscriptionId,
                    });

                  if (commissionError) {
                    logStep("ERROR: Failed to create commission", { error: commissionError.message });
                  } else {
                    logStep("Commission created successfully", { commissionAmount });

                    // Update influencer stats
                    const { error: statsError } = await supabaseClient
                      .from('influencers')
                      .update({
                        total_revenue: influencer.total_revenue + commissionAmount,
                        total_sales: influencer.total_sales + 1,
                        updated_at: new Date().toISOString(),
                      })
                      .eq('id', influencerId);

                    if (statsError) {
                      logStep("ERROR: Failed to update influencer stats", { error: statsError.message });
                    } else {
                      logStep("Influencer stats updated", { 
                        newTotalRevenue: influencer.total_revenue + commissionAmount,
                        newTotalSales: influencer.total_sales + 1
                      });
                    }

                    // Send notification to influencer
                    await supabaseClient
                      .from('notifications')
                      .insert({
                        user_id: influencer.user_id,
                        type: 'task_completed',
                        title: 'Nouvelle vente !',
                        message: `Vous avez gagné ${commissionAmount.toFixed(2)}€ de commission grâce à votre code ${referralCode}`,
                        action_url: '/influenceur/dashboard',
                      });

                    logStep("Notification sent to influencer");

                    // Send email notification to influencer
                    const resendApiKey = Deno.env.get('RESEND_API_KEY');
                    if (resendApiKey) {
                      try {
                        // Get influencer's email from profile
                        const { data: influencerProfile } = await supabaseClient
                          .from('profiles')
                          .select('email')
                          .eq('user_id', influencer.user_id)
                          .single();

                        if (influencerProfile?.email) {
                          const resend = new Resend(resendApiKey);
                          
                          const emailHtml = generateCommissionEmailHtml({
                            beneficiaryName: influencer.beneficiary_name || 'Partenaire',
                            commissionAmount,
                            saleAmount: annualValue,
                            promoCode: referralCode,
                            planType: planType.charAt(0).toUpperCase() + planType.slice(1),
                          });

                          const { error: emailError } = await resend.emails.send({
                            from: 'Agentia <notifications@resend.dev>',
                            to: [influencerProfile.email],
                            subject: `💰 Nouvelle commission: +${commissionAmount.toFixed(2)}€`,
                            html: emailHtml,
                          });

                          if (emailError) {
                            logStep("ERROR: Failed to send commission email", { error: emailError });
                          } else {
                            logStep("Commission email sent to influencer", { email: influencerProfile.email });
                          }
                        }
                      } catch (emailErr) {
                        logStep("ERROR: Email sending failed", { error: String(emailErr) });
                      }
                    }
                  }
                }
              }
        } else if (session.mode === 'payment' && session.metadata?.type === 'overage_pack') {
          const result = await applyOveragePayment(event, OVERAGE_PACK_ACTIONS,
            parameters => supabaseClient.rpc('credit_overage_pack', parameters));
          logStep("Overage payment processed", { sessionId: session.id, ...result });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;
        const productId = subscription.items.data[0]?.price.product as string;
        const planType = planMapping[productId] || 'pro';
        const status = subscription.status === 'active' ? 'active' : subscription.status;

        logStep("Subscription updated", { customerId, productId, planType, status });

        // Find user by stripe_customer_id
        const { data: subscriptionData } = await supabaseClient
          .from('subscriptions')
          .select('user_id')
          .eq('stripe_customer_id', customerId)
          .single();

        if (subscriptionData) {
          const { error: updateError } = await supabaseClient
            .from('subscriptions')
            .update({
              plan_type: planType,
              status: status,
              updated_at: new Date().toISOString(),
            })
            .eq('user_id', subscriptionData.user_id);

          if (updateError) {
            logStep("ERROR: Failed to update subscription", { error: updateError.message });
          } else {
            logStep("Subscription updated successfully", { userId: subscriptionData.user_id, planType });
          }
        } else {
          logStep("No subscription found for customer", { customerId });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        logStep("Subscription deleted", { customerId });

        // Find and update user subscription to free
        const { data: subscriptionData } = await supabaseClient
          .from('subscriptions')
          .select('user_id')
          .eq('stripe_customer_id', customerId)
          .single();

        if (subscriptionData) {
          const { error: updateError } = await supabaseClient
            .from('subscriptions')
            .update({
              plan_type: 'free',
              status: 'canceled',
              updated_at: new Date().toISOString(),
            })
            .eq('user_id', subscriptionData.user_id);

          if (updateError) {
            logStep("ERROR: Failed to update subscription", { error: updateError.message });
          } else {
            logStep("Subscription reverted to free", { userId: subscriptionData.user_id });
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;

        logStep("Payment failed", { customerId, invoiceId: invoice.id });

        // Update subscription status to past_due
        const { data: subscriptionData } = await supabaseClient
          .from('subscriptions')
          .select('user_id')
          .eq('stripe_customer_id', customerId)
          .single();

        if (subscriptionData) {
          const { error: updateError } = await supabaseClient
            .from('subscriptions')
            .update({
              status: 'past_due',
              updated_at: new Date().toISOString(),
            })
            .eq('user_id', subscriptionData.user_id);

          if (updateError) {
            logStep("ERROR: Failed to update subscription status", { error: updateError.message });
          } else {
            logStep("Subscription marked as past_due", { userId: subscriptionData.user_id });
          }
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        // Validate commission after successful payment (not just checkout)
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = invoice.subscription as string;
        
        if (subscriptionId && invoice.billing_reason === 'subscription_create') {
          logStep("First invoice paid, validating commission", { subscriptionId });

          // Find commission with this subscription ID
          const { data: commission, error: findError } = await supabaseClient
            .from('commissions')
            .select('*')
            .eq('subscription_id', subscriptionId)
            .eq('status', 'pending')
            .maybeSingle();

          if (commission && !findError) {
            // Update commission to validated
            const { error: updateError } = await supabaseClient
              .from('commissions')
              .update({ status: 'validated' })
              .eq('id', commission.id);

            if (!updateError) {
              logStep("Commission validated", { commissionId: commission.id });
            }
          }
        }
        break;
      }

      default:
        logStep("Unhandled event type", { type: event.type });
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR in stripe-webhook", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
