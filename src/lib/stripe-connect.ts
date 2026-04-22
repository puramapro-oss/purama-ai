// ─── Purama · Stripe Connect Express (V4.1 — Embedded Components) ────────
//
// Clarification V4.1 : PAS de STRIPE_CONNECT_CLIENT_ID (ca_...) — c'est
// uniquement pour OAuth/Standard accounts. Les Embedded Components utilisent
// des AccountSession créées côté serveur avec STRIPE_SECRET_KEY, et un
// client_secret transmis au navigateur (courte durée, lié au compte user).
//
// Flow :
//  1. Client appelle /functions/v1/connect-account-session
//  2. Edge Function crée AccountSession + renvoie client_secret
//  3. Client initialise <ConnectOnboarding> ou <ConnectPayouts> avec ce secret
// ───────────────────────────────────────────────────────────────────────

import { supabase } from '@/integrations/supabase/client';

export type ConnectComponent =
  | 'account_onboarding'
  | 'account_management'
  | 'notification_banner'
  | 'payouts'
  | 'payments'
  | 'balances'
  | 'documents';

export interface AccountSessionResponse {
  client_secret: string;
  expires_at: number; // epoch seconds
  account_id: string;
}

/**
 * Crée (ou récupère) une AccountSession pour Embedded Components.
 * À appeler avant de monter <ConnectComponents /> dans l'UI.
 */
export async function createAccountSession(
  components: ConnectComponent[] = [
    'account_onboarding',
    'account_management',
    'payouts',
    'balances',
    'documents',
  ],
): Promise<AccountSessionResponse> {
  const { data, error } = await supabase.functions.invoke('connect-account-session', {
    body: { components },
  });
  if (error) throw new Error(`Stripe Connect : ${error.message}`);
  return data as AccountSessionResponse;
}

/**
 * Retourne le statut Connect du user courant depuis `public.connect_accounts`.
 */
export async function getConnectStatus(): Promise<{
  has_account: boolean;
  onboarding_completed: boolean;
  payouts_enabled: boolean;
  charges_enabled: boolean;
} | null> {
  const { data, error } = await supabase
    .from('connect_accounts')
    .select('onboarding_completed, payouts_enabled, charges_enabled')
    .single();
  if (error || !data) return { has_account: false, onboarding_completed: false, payouts_enabled: false, charges_enabled: false };
  return {
    has_account: true,
    onboarding_completed: data.onboarding_completed,
    payouts_enabled: data.payouts_enabled,
    charges_enabled: data.charges_enabled,
  };
}
