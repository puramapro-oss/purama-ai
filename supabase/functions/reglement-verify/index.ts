// ─── Edge Function · Verify Règlement (V4.1) ─────────────────────────────
// Public. Retourne les métadonnées d'un règlement + sa preuve OpenTimestamps.
//
// La vérification cryptographique complète de la preuve (walk de la chaîne
// d'attestations → Bitcoin block header) nécessite des accès réseau multiples
// et l'évaluation des opérations SHA-256/append/prepend qui composent la
// preuve. On l'exécute côté client (ou via OT CLI externe) plutôt que dans
// l'Edge Function — plus léger et pas de dépendance Node-only.
//
// Retour :
//  · proof_base64 : la preuve complète à soumettre à une tierce partie
//  · verify_url : vers opentimestamps.org pour vérifier dans le navigateur
//  · content_hash : le hash SHA-256 du règlement
// ───────────────────────────────────────────────────────────────────────

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.91.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
};

serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    let id = url.searchParams.get('id');
    if (!id) {
      const body = await req.json().catch(() => ({}));
      id = body.id ?? null;
    }
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

    // Recalcul du hash pour vérifier l'intégrité locale
    const bytes = new TextEncoder().encode(r.content_markdown ?? '');
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
    const computedHashHex = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const hashMatches = computedHashHex === r.content_hash;

    if (!r.opentimestamps_proof) {
      return json({
        verified: false,
        pending: true,
        hash_matches: hashMatches,
        content_hash: r.content_hash,
        version: r.version,
        type: r.type,
        published_at: r.published_at,
        note: "Hash stocké. Ancrage blockchain à programmer en batch ('ots stamp' local).",
      });
    }

    return json({
      verified: hashMatches, // le hash local correspond au hash stocké
      pending_bitcoin: true, // la confirmation Bitcoin peut prendre ~2-6h après stamp
      hash_matches: hashMatches,
      content_hash: r.content_hash,
      version: r.version,
      type: r.type,
      published_at: r.published_at,
      blockchain: r.blockchain,
      proof_base64: r.opentimestamps_proof,
      verify_instructions: {
        cli: `echo '${r.content_markdown?.slice(0, 60)}…' | sha256sum  # puis 'ots verify' avec la preuve base64 ci-dessus`,
        web: 'https://opentimestamps.org',
        note: 'Sauvegarde la preuve base64 + le contenu dans 2 fichiers, puis utilise https://github.com/opentimestamps/opentimestamps-client pour vérifier hors-ligne.',
      },
    });
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
