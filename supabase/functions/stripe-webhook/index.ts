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

function stripeObjectId(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
    && !('deleted' in value && value.deleted === true)) return value.id;
  return undefined;
}

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

type SubscriptionLink = { id: string; user_id: string; stripe_customer_id: string | null };
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
    .select('id,user_id,stripe_customer_id').eq(column, value).maybeSingle();
  if (error) throw new Error('Subscription identity lookup failed; retry or reconcile');
  if (!data) return null;
  if (typeof data.id !== 'string' || !data.id || typeof data.user_id !== 'string' || !data.user_id
    || (data.stripe_customer_id !== null && typeof data.stripe_customer_id !== 'string')
    || data[column] !== value) throw new Error('Subscription identity requires reconciliation');
  return data;
}

async function checkoutSubscription(
  client: SubscriptionClient, customerId: string, email: string | null | undefined,
): Promise<SubscriptionLink | null> {
  // The persisted provider binding wins over display email or caller metadata.
  // This schema has no stripe_subscription_id column; never invent that binding.
  const bound = await storedSubscription(client, 'stripe_customer_id', customerId);
  if (bound) return bound;
  if (typeof email !== 'string' || !email || email.length > 320) {
    throw new Error('Unbound subscription customer requires reconciliation');
  }

  // Legacy accounts may predate provider binding. Scan exact email matches to
  // exhaustion, not merely until the first match. Limits bound work and fail
  // closed; provider pagination hints are not used as an authorization shortcut.
  const perPage = 1000;
  const maxPages = 50;
  const seen = new Set<string>();
  let matchedUserId: string | null = null;
  for (let page = 1; page <= maxPages; page++) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage });
    if (error || !Array.isArray(data?.users) || data.users.length > perPage) {
      throw new Error('Legacy subscription user lookup failed; retry or reconcile');
    }
    if (data.users.length === 0) {
      if (!matchedUserId) return null;
      const legacy = await storedSubscription(client, 'user_id', matchedUserId);
      if (legacy && legacy.stripe_customer_id !== null && legacy.stripe_customer_id !== customerId) {
        throw new Error('Legacy subscription customer binding conflicts');
      }
      return legacy;
    }
    for (const user of data.users) {
      if (!user || typeof user.id !== 'string' || !user.id || seen.has(user.id)) {
        throw new Error('Legacy subscription pagination requires reconciliation');
      }
      seen.add(user.id);
      if (user.email === email) {
        if (matchedUserId && matchedUserId !== user.id) throw new Error('Legacy subscription email is ambiguous');
        matchedUserId = user.id;
      }
    }
  }
  throw new Error('Legacy subscription user lookup limit reached; reconciliation required');
}

async function persistSubscription(
  client: SubscriptionClient, link: SubscriptionLink, patch: Record<string, unknown>,
): Promise<void> {
  // Compare the binding read above before updating. A concurrent reassignment,
  // zero-row write or missing receipt must stop before commission side effects.
  let query = client.from('subscriptions').update(patch).eq('id', link.id).eq('user_id', link.user_id);
  query = link.stripe_customer_id === null
    ? query.is('stripe_customer_id', null) : query.eq('stripe_customer_id', link.stripe_customer_id);
  const { data, error } = await query.select('id,user_id,stripe_customer_id').single();
  const expectedCustomer = patch.stripe_customer_id ?? link.stripe_customer_id;
  if (error || !data || data.id !== link.id || data.user_id !== link.user_id
    || data.stripe_customer_id !== expectedCustomer) {
    throw new Error('Subscription persistence failed; retry before further effects');
  }
}

// Plan prices for commission calculation (monthly price in EUR) — cf src/lib/plans.ts PLANS
const planPrices: Record<string, number> = {
  'starter': 33,
  'pro': 99,
  'ultime': 199,
};

// Taille du pack de dépassement — cf OVERAGE_PACK.actions dans src/lib/plans.ts (1 seule source de
// vérité déclarée ; dupliquée ici car cette fonction Deno n'importe pas src/lib).
const OVERAGE_PACK_ACTIONS = 2000;

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
        logStep("Checkout session completed", { 
          sessionId: session.id, 
          customerId: session.customer,
          customerEmail: session.customer_email,
          metadata: session.metadata
        });

        if (session.mode === 'subscription' && session.subscription) {
          // Completion alone is not payment confirmation for delayed methods.
          if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
            logStep('Subscription checkout awaiting payment', { sessionId: session.id });
            break;
          }
          const subscriptionId = stripeObjectId(session.subscription);
          if (session.status !== 'complete' || !subscriptionId) throw new Error('Subscription checkout requires reconciliation');
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const { planType } = subscriptionPlan(subscription);
          if (subscription.status !== 'active' && subscription.status !== 'trialing') {
            logStep('Subscription checkout not eligible for activation', { sessionId: session.id, status: subscription.status });
            break;
          }
          if (session.payment_status === 'no_payment_required' && subscription.status !== 'trialing') {
            logStep('Subscription checkout has no confirmed payment', { sessionId: session.id });
            break;
          }
          const customerId = stripeObjectId(session.customer);
          if (stripeObjectId(subscription.customer) !== customerId
            || !customerId) throw new Error('Subscription customer requires reconciliation');
          const confirmedState = await confirmedSubscriptionState(subscription, stripe);
          const customerEmail = session.customer_email || session.customer_details?.email;

          // Extract influencer info from metadata
          const referralCode = session.metadata?.referral_code;
          const influencerId = session.metadata?.influencer_id;

          if (customerEmail || customerId) {
            const link = await checkoutSubscription(supabaseClient, customerId, customerEmail);
            const user = link ? { id: link.user_id } : null;

            if (user && link) {
              // A confirmed row receipt is required before any later effect.
              await persistSubscription(supabaseClient, link, {
                  plan_type: planType,
                  ...confirmedState,
                  stripe_customer_id: customerId,
                  updated_at: new Date().toISOString(),
              });
              logStep("Subscription updated successfully", { userId: user.id, planType });

              // Handle influencer commission if referral was used
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
                      subscription_id: session.subscription as string,
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
            } else {
              throw new Error('Subscription user or local subscription requires reconciliation');
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
        const received = event.data.object as Stripe.Subscription;
        // Read current provider state so an older active event cannot undo a
        // cancellation that has already reached Stripe.
        const subscription = await stripe.subscriptions.retrieve(received.id);
        const customerId = stripeObjectId(subscription.customer);
        if (!customerId) throw new Error('Subscription customer requires reconciliation');
        const { productId, planType } = subscriptionPlan(subscription);
        const confirmedState = await confirmedSubscriptionState(subscription, stripe);
        const status = confirmedState.status;

        logStep("Subscription updated", { customerId, productId, planType, status });

        // Find user by stripe_customer_id
        const subscriptionData = await storedSubscription(supabaseClient, 'stripe_customer_id', customerId);

        if (subscriptionData) {
          await persistSubscription(supabaseClient, subscriptionData, {
              plan_type: planType,
              ...confirmedState,
              updated_at: new Date().toISOString(),
          });
          logStep("Subscription updated successfully", { userId: subscriptionData.user_id, planType });
        } else {
          throw new Error('Subscription customer binding requires reconciliation');
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = stripeObjectId(subscription.customer);
        if (!customerId) throw new Error('Subscription customer requires reconciliation');

        logStep("Subscription deleted", { customerId });

        // Find and update user subscription to free
        const subscriptionData = await storedSubscription(supabaseClient, 'stripe_customer_id', customerId);

        if (subscriptionData) {
          await persistSubscription(supabaseClient, subscriptionData, {
              plan_type: 'free',
              status: 'canceled',
              updated_at: new Date().toISOString(),
          });
          logStep("Subscription reverted to free", { userId: subscriptionData.user_id });
        } else {
          throw new Error('Subscription customer binding requires reconciliation');
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = stripeObjectId(invoice.customer);
        if (!customerId) throw new Error('Subscription customer requires reconciliation');

        logStep("Payment failed", { customerId, invoiceId: invoice.id });

        // Update subscription status to past_due
        const subscriptionData = await storedSubscription(supabaseClient, 'stripe_customer_id', customerId);

        if (subscriptionData) {
          await persistSubscription(supabaseClient, subscriptionData, {
              status: 'past_due',
              updated_at: new Date().toISOString(),
          });
          logStep("Subscription marked as past_due", { userId: subscriptionData.user_id });
        } else {
          throw new Error('Subscription customer binding requires reconciliation');
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
