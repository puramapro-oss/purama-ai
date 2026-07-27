// ─── Edge Function · Stripe Connect Express AccountSession (V4.1) ────────
// Crée (ou récupère) un compte Connect Express + retourne un client_secret
// d'AccountSession pour Embedded Components.
//
// Appelé par le client via supabase.functions.invoke('connect-account-session').
// ───────────────────────────────────────────────────────────────────────

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@15.12.0?target=deno&deno-std=0.224.0';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ALLOWED_COMPONENTS = [
  'account_onboarding',
  'account_management',
  'notification_banner',
  'payouts',
  'payments',
  'balances',
  'documents',
] as const;
type Component = typeof ALLOWED_COMPONENTS[number];

serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) {
      return json({ error: 'Non authentifié' }, 401);
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: auth } } },
    );

    const { data: userData, error: userErr } = await supabaseUser.auth.getUser();
    if (userErr || !userData.user) return json({ error: 'Session invalide' }, 401);
    const user = userData.user;

    const body = await req.json().catch(() => ({}));
    const requested: Component[] = Array.isArray(body.components)
      ? body.components.filter((c: string): c is Component => (ALLOWED_COMPONENTS as readonly string[]).includes(c))
      : (ALLOWED_COMPONENTS as readonly Component[]).slice();

    // httpClient explicite requis en environnement Deno/edge (cf ERRORS.md 2026-07-27)
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
      apiVersion: '2025-09-30.clover',
      httpClient: Stripe.createFetchHttpClient(),
      timeout: 10_000,
    });

    // 1. Récupère ou crée le compte Connect Express
    const { data: existing } = await supabaseAdmin
      .from('connect_accounts')
      .select('stripe_account_id')
      .eq('user_id', user.id)
      .maybeSingle();

    let accountId = existing?.stripe_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'FR',
        email: user.email,
        capabilities: { transfers: { requested: true } },
        controller: {
          fees: { payer: 'account' },
          losses: { payments: 'application' },
          stripe_dashboard: { type: 'none' },
        },
      });
      accountId = account.id;
      await supabaseAdmin.from('connect_accounts').insert({
        user_id: user.id,
        stripe_account_id: accountId,
        onboarding_completed: false,
        payouts_enabled: false,
        charges_enabled: false,
        country: 'FR',
      });
    }

    // 2. AccountSession pour Embedded Components
    const components = Object.fromEntries(requested.map((c) => [c, { enabled: true }])) as Record<Component, { enabled: boolean }>;
    const session = await stripe.accountSessions.create({ account: accountId, components });

    return json({
      client_secret: session.client_secret,
      expires_at: session.expires_at,
      account_id: accountId,
    });
  } catch (e) {
    console.error('[connect-account-session]', e);
    return json({ error: (e as Error).message }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
