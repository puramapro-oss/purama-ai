import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[STRIPE-WEBHOOK] ${step}${detailsStr}`);
};

// Map Stripe product IDs to internal plan types
const planMapping: Record<string, string> = {
  'prod_Tq9M8BqZXnWp8A': 'starter',
  'prod_Tq9Q2m69e3A5h4': 'premium',
  'prod_Tq9R8iVUYzD0UE': 'enterprise',
};

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

  const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
  
  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
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
      event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
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
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        logStep("Checkout session completed", { 
          sessionId: session.id, 
          customerId: session.customer,
          customerEmail: session.customer_email 
        });

        if (session.mode === 'subscription' && session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
          const productId = subscription.items.data[0]?.price.product as string;
          const planType = planMapping[productId] || 'premium';
          const customerEmail = session.customer_email || session.customer_details?.email;

          if (customerEmail) {
            // Find user by email
            const { data: userData } = await supabaseClient.auth.admin.listUsers();
            const user = userData?.users?.find(u => u.email === customerEmail);

            if (user) {
              // Update subscription in database
              const { error: updateError } = await supabaseClient
                .from('subscriptions')
                .update({
                  plan_type: planType,
                  status: 'active',
                  stripe_customer_id: session.customer as string,
                  updated_at: new Date().toISOString(),
                })
                .eq('user_id', user.id);

              if (updateError) {
                logStep("ERROR: Failed to update subscription", { error: updateError.message });
              } else {
                logStep("Subscription updated successfully", { userId: user.id, planType });
              }
            } else {
              logStep("User not found for email", { email: customerEmail });
            }
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;
        const productId = subscription.items.data[0]?.price.product as string;
        const planType = planMapping[productId] || 'premium';
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
