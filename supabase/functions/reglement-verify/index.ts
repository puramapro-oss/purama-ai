// ─── Edge Function · Verify Règlement OpenTimestamps (V4.1) ──────────────
// Public. Vérifie qu'un règlement stocké a bien été horodaté sur Bitcoin.
// ───────────────────────────────────────────────────────────────────────

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
// @deno-types="https://esm.sh/javascript-opentimestamps@0.4.9/dist/index.d.ts"
import OpenTimestamps from 'https://esm.sh/javascript-opentimestamps@0.4.9?target=deno';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
};

serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const id = url.searchParams.get('id') ?? (await req.json().catch(() => ({}))).id;
    if (!id) return json({ error: 'id requis' }, 400);

    const client = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
    );
    const { data: r, error } = await client
      .from('reglements')
      .select('id, version, type, content_hash, opentimestamps_proof, content_markdown, published_at, blockchain')
      .eq('id', id)
      .single();

    if (error || !r) return json({ error: 'Règlement introuvable' }, 404);
    if (!r.opentimestamps_proof) return json({ verified: false, error: 'Pas de preuve blockchain' });

    // Recalcul hash
    const bytes = new TextEncoder().encode(r.content_markdown ?? '');
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
    const hash = new Uint8Array(hashBuf);

    const detachedOriginal = OpenTimestamps.DetachedTimestampFile.fromHash(
      new OpenTimestamps.Ops.OpSHA256(),
      hash,
    );
    const proofBytes = Uint8Array.from(atob(r.opentimestamps_proof), (c) => c.charCodeAt(0));
    const detachedProof = OpenTimestamps.DetachedTimestampFile.deserialize(proofBytes);

    try {
      const result = await OpenTimestamps.verify(detachedProof, detachedOriginal);
      if (result && result.bitcoin) {
        return json({
          verified: true,
          blockHeight: result.bitcoin.height,
          timestamp: new Date(result.bitcoin.timestamp * 1000).toISOString(),
          version: r.version,
          type: r.type,
          hash: r.content_hash,
          blockchain: r.blockchain,
        });
      }
      return json({ verified: false, pending: true, note: 'Preuve pas encore confirmée dans un bloc Bitcoin (attendre ~2-6h après publication).' });
    } catch (e) {
      return json({ verified: false, error: (e as Error).message });
    }
  } catch (e) {
    console.error('[reglement-verify]', e);
    return json({ error: (e as Error).message }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
