import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Coupon ID for influencer referrals (-50% for first year)
const INFLUENCER_COUPON_ID = "lHDOePig";

const logStep = (step: string, details?: Record<string, unknown>) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CREATE-CHECKOUT] ${step}${detailsStr}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseClient = createClient(
      
    Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { db: { schema: 'purama_ai' } }
    );

  const supabaseAdmin = createClient(
      
    Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { db: { schema: 'purama_ai' } }
    );

  try {
    logStep("Function started");

    const { priceId, referralCode } = await req.json();
    if (!priceId) throw new Error("Price ID is required");
    logStep("Price ID received", { priceId, referralCode });

    const authHeader = req.headers.get("Authorization")!;
    const token = authHeader.replace("Bearer ", "");
    const { data } = await supabaseClient.auth.getUser(token);
    const user = data.user;
    if (!user?.email) throw new Error("User not authenticated or email not available");
    logStep("User authenticated", { userId: user.id, email: user.email });

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", { 
      apiVersion: "2025-08-27.basil" 
    });

    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    let customerId;
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;
      logStep("Existing customer found", { customerId });
    }

    const origin = req.headers.get("origin") || "https://purama-ai.purama.dev";
    
    // Check if referral code is valid and influencer exists
    let validInfluencer = null;
    let applyCoupon = false;

    if (referralCode) {
      logStep("Checking referral code", { referralCode });
      
      const { data: influencer, error: infError } = await supabaseAdmin
        .from('influencers')
        .select('*')
        .eq('promo_code', referralCode.toUpperCase())
        .eq('contract_status', 'signed')
        .maybeSingle();

      if (!infError && influencer) {
        const expiresAt = new Date(influencer.expires_at);
        if (expiresAt > new Date()) {
          validInfluencer = influencer;
          applyCoupon = true;
          logStep("Valid influencer found", { 
            influencerId: influencer.id, 
            promoCode: influencer.promo_code,
            expiresAt: influencer.expires_at 
          });
        } else {
          logStep("Influencer link expired", { expiresAt: influencer.expires_at });
        }
      } else {
        logStep("Influencer not found or not signed", { referralCode });
      }
    }

    // Build checkout session options
    const sessionOptions: Stripe.Checkout.SessionCreateParams = {
      customer: customerId,
      customer_email: customerId ? undefined : user.email,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: "subscription",
      success_url: `${origin}/pricing?success=true`,
      cancel_url: `${origin}/pricing?canceled=true`,
      metadata: {
        user_id: user.id,
        referral_code: validInfluencer?.promo_code || '',
        influencer_id: validInfluencer?.id || '',
      },
      // 14-day free trial
      subscription_data: {
        trial_period_days: 14,
      },
    };

    // Apply coupon if valid influencer referral
    if (applyCoupon) {
      sessionOptions.discounts = [{ coupon: INFLUENCER_COUPON_ID }];
      logStep("Applying influencer coupon", { couponId: INFLUENCER_COUPON_ID });
    }
    
    const session = await stripe.checkout.sessions.create(sessionOptions);

    logStep("Checkout session created", { 
      sessionId: session.id, 
      hasCoupon: applyCoupon,
      influencerCode: validInfluencer?.promo_code 
    });

    return new Response(JSON.stringify({ 
      url: session.url,
      hasDiscount: applyCoupon,
      influencerName: validInfluencer?.beneficiary_name || null,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
