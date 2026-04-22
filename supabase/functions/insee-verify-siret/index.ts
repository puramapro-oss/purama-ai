// ─── Edge Function · INSEE Sirene verify-siret (V4.1) ────────────────────
// Proxy vers l'API INSEE Sirene 3.11 — clé universelle Purama.
// ───────────────────────────────────────────────────────────────────────

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { siret } = await req.json();
    if (typeof siret !== 'string' || !/^\d{14}$/.test(siret)) {
      return json({ valid: false, active: false, error: 'SIRET invalide (14 chiffres).' }, 400);
    }

    const apiKey = Deno.env.get('INSEE_API_KEY');
    if (!apiKey) return json({ valid: false, active: false, error: 'Clé INSEE non configurée.' }, 500);

    const res = await fetch(`https://api.insee.fr/entreprises/sirene/V3.11/siret/${siret}`, {
      headers: {
        'X-INSEE-Api-Key-Integration': apiKey,
        'Accept': 'application/json',
      },
    });

    if (res.status === 404) {
      return json({ valid: false, active: false, error: 'SIRET inconnu.' }, 200);
    }
    if (!res.ok) {
      return json({ valid: false, active: false, error: `INSEE ${res.status}` }, 200);
    }

    const data = await res.json();
    const e = data.etablissement;
    const u = e.uniteLegale;
    const adr = e.adresseEtablissement;
    const active = e.etatAdministratifEtablissement === 'A';

    return json({
      valid: true,
      active,
      etablissement: {
        siret: e.siret,
        siren: e.siren,
        denominationUniteLegale: u.denominationUniteLegale ?? (`${u.prenomUsuelUniteLegale ?? ''} ${u.nomUniteLegale ?? ''}`.trim() || null),
        categorieJuridique: u.categorieJuridiqueUniteLegale ?? null,
        activitePrincipaleEtablissement: e.periodesEtablissement?.[0]?.activitePrincipaleEtablissement ?? null,
        dateCreationEtablissement: e.dateCreationEtablissement ?? null,
        etatAdministratifEtablissement: e.etatAdministratifEtablissement,
        adresse: {
          numero: adr?.numeroVoieEtablissement ?? null,
          voie: (`${adr?.typeVoieEtablissement ?? ''} ${adr?.libelleVoieEtablissement ?? ''}`.trim() || null),
          codePostal: adr?.codePostalEtablissement ?? null,
          commune: adr?.libelleCommuneEtablissement ?? null,
        },
      },
    });
  } catch (err) {
    console.error('[insee-verify-siret]', err);
    return json({ valid: false, active: false, error: (err as Error).message }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
