// ─── Edge Function · Publish Règlement (V4.1) ────────────────────────────
// Stocke un règlement (jeu-concours, prime, bourse, CGV) + horodate son hash
// directement sur un calendrier OpenTimestamps via HTTP (Bitcoin backend).
// Admin only (vérifie rôle super_admin).
//
// Note : la lib npm `opentimestamps` dépend de `fs` (Node), incompatible
// avec l'Edge Runtime Deno. On implémente le protocol OT minimal en
// appelant directement un calendar OpenTimestamps (Alice/Bob/Eternity Wall).
// La preuve retournée est opaque pour nous — elle contient la chaîne
// d'attestation qui sera confirmée dans Bitcoin sous ~2-6 heures.
// ───────────────────────────────────────────────────────────────────────

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.91.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const OT_CALENDARS = [
  'https://alice.btc.calendar.opentimestamps.org',
  'https://bob.btc.calendar.opentimestamps.org',
  'https://finney.calendar.eternitywall.com',
];

serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return json({ error: 'Non authentifié' }, 401);

    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: auth } } },
    );
    const { data: userRes } = await supabaseUser.auth.getUser();
    if (!userRes?.user) return json({ error: 'Session invalide' }, 401);

    // Vérif super_admin
    const { data: profile } = await supabaseUser
      .from('profiles')
      .select('role')
      .eq('id', userRes.user.id)
      .single();
    if (profile?.role !== 'super_admin') return json({ error: 'Accès refusé' }, 403);

    const { version, type, content, content_url } = await req.json();
    if (!version || !type || !content) {
      return json({ error: 'version, type, content requis.' }, 400);
    }

    // Hash SHA-256 du contenu
    const bytes = new TextEncoder().encode(content);
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
    const hash = new Uint8Array(hashBuf);
    const hashHex = Array.from(hash).map((b) => b.toString(16).padStart(2, '0')).join('');

    // Appel direct calendrier OpenTimestamps (racine commit)
    // Protocol : POST /digest avec le hash binaire → retourne un "head" binaire
    // qui constitue la pending attestation. Elle sera upgradée dans Bitcoin
    // dans les heures suivantes par les calendriers.
    let proofBase64: string | null = null;
    for (const calendar of OT_CALENDARS) {
      try {
        const res = await fetch(`${calendar}/digest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'Accept': 'application/octet-stream' },
          body: hash,
        });
        if (!res.ok) continue;
        const proofBytes = new Uint8Array(await res.arrayBuffer());
        if (proofBytes.byteLength === 0) continue;
        proofBase64 = btoa(String.fromCharCode(...proofBytes));
        break;
      } catch {
        continue;
      }
    }

    // Store
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const { data: row, error } = await admin
      .from('reglements')
      .insert({
        version,
        type,
        content_hash: hashHex,
        opentimestamps_proof: proofBase64,
        blockchain: 'bitcoin',
        content_url: content_url ?? null,
        content_markdown: content,
      })
      .select()
      .single();

    if (error) return json({ error: error.message }, 500);

    return json({
      ok: true,
      reglement: row,
      stamped: proofBase64 !== null,
      note: proofBase64
        ? 'Hash envoyé à OpenTimestamps. Confirmation Bitcoin dans ~2-6h.'
        : 'Hash stocké, horodatage blockchain à programmer en batch.',
    });
  } catch (e) {
    console.error('[reglement-publish]', e);
    return json({ error: (e as Error).message }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
