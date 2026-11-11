// Stripe Connect AccountSession: confirmed binding and durable provisioning.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@15.12.0?target=deno&deno-std=0.224.0';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.91.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const API_VERSION = '2025-09-30.clover';
const ALLOWED_COMPONENTS = [
  'account_onboarding', 'account_management', 'notification_banner',
  'payouts', 'payments', 'balances', 'documents',
] as const;
type Component = typeof ALLOWED_COMPONENTS[number];
const unavailable = () => json({ error: 'Compte de paiement temporairement indisponible' }, 503);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const accountId = (value: unknown): value is string =>
  typeof value === 'string' && /^acct_[A-Za-z0-9_]+$/.test(value);

serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405);
  try {
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return json({ error: 'Non authentifié' }, 401);
    const supabaseAdmin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const supabaseUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: auth } } });
    const { data: userData, error: userErr } = await supabaseUser.auth.getUser();
    if (userErr || !userData.user) return json({ error: 'Session invalide' }, 401);
    const user = userData.user;
    const body: unknown = await req.json().catch(() => null);
    if (!record(body)) return json({ error: 'Requête invalide' }, 400);
    const requested: Component[] = Array.isArray(body.components)
      ? body.components.filter((component: unknown): component is Component =>
        typeof component === 'string' && (ALLOWED_COMPONENTS as readonly string[]).includes(component))
      : [...ALLOWED_COMPONENTS];
    if (requested.length === 0) return json({ error: 'Requête invalide' }, 400);

    const secretKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!secretKey) return unavailable();
    const stripe = new Stripe(secretKey, {
      apiVersion: API_VERSION, httpClient: Stripe.createFetchHttpClient(),
      timeout: 10_000, maxNetworkRetries: 0,
    });
    let linkedAccount: string;
    {
      // This fingerprint is private and never logged or returned to the client.
      // Rotation/context changes require reconciliation instead of silently
      // starting the same operation under another Stripe account or mode.
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secretKey));
      const providerContext = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const parameters = {
        type: 'express', country: 'FR', ...(user.email ? { email: user.email } : {}),
        capabilities: { transfers: { requested: true } },
        controller: {
          fees: { payer: 'account' }, losses: { payments: 'application' },
          stripe_dashboard: { type: 'none' },
        },
      };
      const claimStarted = performance.now();
      const { data: claim, error: claimError } = await supabaseAdmin.rpc('claim_connect_account_provision', {
        p_user_id: user.id, p_parameters: parameters, p_api_version: API_VERSION, p_provider_context: providerContext,
      });
      if (claimError || !record(claim) || claim.user_id !== user.id) return unavailable();
      // Every session, including an existing binding, passes through the RPC's
      // journal/quarantine checks. There is no direct binding-only shortcut.
      if (claim.decision === 'bound' && accountId(claim.stripe_account_id)) {
        linkedAccount = claim.stripe_account_id;
      } else {
        if (claim.decision !== 'create' || typeof claim.operation_id !== 'string'
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(claim.operation_id)
          || typeof claim.idempotency_key !== 'string'
          || claim.idempotency_key !== `connect-create:${claim.operation_id}`
          || claim.api_version !== API_VERSION || claim.provider_context !== providerContext
          || !record(claim.parameters) || !record(claim.parameters.metadata)
          || claim.parameters.metadata.purama_connect_operation !== claim.operation_id) return unavailable();
        const serverNow = typeof claim.server_now === 'string' ? Date.parse(claim.server_now) : NaN;
        const retryUntil = typeof claim.retry_until === 'string' ? Date.parse(claim.retry_until) : NaN;
        const leaseUntil = typeof claim.lease_until === 'string' ? Date.parse(claim.lease_until) : NaN;
        const remaining = Math.min(retryUntil - serverNow, leaseUntil - serverNow)
          - (performance.now() - claimStarted);
        // Check the DB-issued deadline immediately before the provider call.
        // The RPC uses 23 hours, leaving margin before Stripe's >=24h pruning.
        if (!Number.isFinite(remaining) || remaining < 15_000) return unavailable();
        const account = await stripe.accounts.create(
          claim.parameters as Parameters<typeof stripe.accounts.create>[0],
          { idempotencyKey: claim.idempotency_key },
        );
        if (!accountId(account.id)) return unavailable();
        const verified = record(account.metadata)
          && account.metadata.purama_connect_operation === claim.operation_id;
        const { data: finalized, error: finalizeError } = await supabaseAdmin.rpc('finalize_connect_account_provision', {
          p_user_id: user.id, p_operation_id: claim.operation_id,
          p_account_id: account.id, p_provider_verified: verified,
        });
        if (finalizeError || !record(finalized) || finalized.decision !== 'bound'
          || finalized.user_id !== user.id || finalized.operation_id !== claim.operation_id
          || finalized.stripe_account_id !== account.id) return unavailable();
        linkedAccount = account.id;
      }
    }

    const components = Object.fromEntries(requested.map(component => [component, { enabled: true }])) as Record<Component, { enabled: boolean }>;
    const session = await stripe.accountSessions.create({ account: linkedAccount, components });
    return json({ client_secret: session.client_secret, expires_at: session.expires_at, account_id: linkedAccount });
  } catch {
    // Provider/SQL exceptions may contain credentials or personal data. Keep
    // only a stable event code, including in server logs.
    console.error('[connect-account-session] unavailable');
    return unavailable();
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...(status === 405 ? { Allow: 'POST, OPTIONS' } : {}) },
  });
}
