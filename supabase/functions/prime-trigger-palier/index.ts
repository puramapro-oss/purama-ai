// ─── Edge Function · Prime Trigger Palier (V4.1 CRON quotidien) ──────────
// Parcourt les primes actives, vérifie le statut d'abonnement aligné et
// verse le palier correspondant dans wallet_transactions + profile wallet_balance.
// Appelé via cron (n8n / Supabase scheduled).
// ───────────────────────────────────────────────────────────────────────

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.91.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type PrimeMode = 'phase1' | 'phase2';

// Phase 1 : J1 / J30 / J60 · Phase 2 : J7 / J30 / J60
const PALIER_DAYS: Record<PrimeMode, [number, number, number]> = {
  phase1: [1, 30, 60],
  phase2: [7, 30, 60],
};
const PALIER_AMOUNTS: [number, number, number] = [25, 25, 50];

serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // Auth CRON : header x-cron-secret partagé
  const cronSecret = req.headers.get('x-cron-secret');
  if (cronSecret !== Deno.env.get('CRON_SECRET')) {
    return json({ error: 'Forbidden' }, 403);
  }

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: primes, error } = await admin
      .from('primes')
      .select('id, user_id, app_id, palier_actuel, prime_mode, created_at, subscription_payment_check_1, subscription_payment_check_2, subscription_payment_check_3, recuperee')
      .lt('palier_actuel', 3)
      .eq('recuperee', false);
    if (error) return json({ error: error.message }, 500);

    const results: Array<{ user_id: string; palier: number; amount: number; status: string }> = [];

    for (const p of primes ?? []) {
      const mode = (p.prime_mode as PrimeMode) ?? 'phase1';
      const days = PALIER_DAYS[mode];
      const createdAt = new Date(p.created_at).getTime();
      const now = Date.now();
      const daysSince = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));

      const nextPalier = (p.palier_actuel ?? 0) + 1;
      const palierIdx = nextPalier - 1;
      if (daysSince < days[palierIdx]) continue;

      const paymentField = `subscription_payment_check_${nextPalier}` as
        | 'subscription_payment_check_1'
        | 'subscription_payment_check_2'
        | 'subscription_payment_check_3';
      const paymentOk = p[paymentField] === true;
      if (!paymentOk) {
        results.push({ user_id: p.user_id, palier: nextPalier, amount: 0, status: 'subscription_payment_pending' });
        continue;
      }

      const amount = PALIER_AMOUNTS[palierIdx];

      // Crédit wallet_transactions
      const { error: txErr } = await admin.from('wallet_transactions').insert({
        user_id: p.user_id,
        amount_eur: amount,
        direction: 'credit',
        source: `prime_j${days[palierIdx]}`,
        source_id: p.id,
        description: `Prime de bienvenue palier ${nextPalier} · J${days[palierIdx]}`,
        metadata: { app_id: p.app_id, mode, palier: nextPalier },
      });
      if (txErr) {
        results.push({ user_id: p.user_id, palier: nextPalier, amount, status: `tx_error: ${txErr.message}` });
        continue;
      }

      // Maj wallet_balance profile (compteur cumulé)
      await admin.rpc('increment_wallet_balance', { p_user_id: p.user_id, p_amount: amount }).then(() => null).catch(() => null);

      // Maj prime
      const dateField = `palier_${nextPalier}_date` as 'palier_1_date' | 'palier_2_date' | 'palier_3_date';
      await admin
        .from('primes')
        .update({
          palier_actuel: nextPalier,
          montant_verse_eur: (PALIER_AMOUNTS.slice(0, nextPalier).reduce((a, b) => a + b, 0)),
          [dateField]: new Date().toISOString(),
        })
        .eq('id', p.id);

      results.push({ user_id: p.user_id, palier: nextPalier, amount, status: 'credited' });
    }

    return json({ ok: true, processed: results.length, results });
  } catch (e) {
    console.error('[prime-trigger-palier]', e);
    return json({ error: (e as Error).message }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
