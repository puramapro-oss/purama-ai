// ─── Edge Function · Publish Règlement + OpenTimestamps (V4.1) ───────────
// Stocke un règlement (jeu-concours, prime, bourse, CGV) + horodate son hash
// sur la blockchain Bitcoin via OpenTimestamps.
// Admin only (vérifie rôle super_admin).
// ───────────────────────────────────────────────────────────────────────

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
// @deno-types="https://esm.sh/javascript-opentimestamps@0.4.9/dist/index.d.ts"
import OpenTimestamps from 'https://esm.sh/javascript-opentimestamps@0.4.9?target=deno';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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

    // Horodatage OpenTimestamps
    const detachedFile = OpenTimestamps.DetachedTimestampFile.fromHash(
      new OpenTimestamps.Ops.OpSHA256(),
      hash,
    );
    await OpenTimestamps.stamp(detachedFile);
    const proofBytes = detachedFile.serializeToBytes();
    const proofBase64 = btoa(String.fromCharCode(...proofBytes));

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

    return json({ ok: true, reglement: row });
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
