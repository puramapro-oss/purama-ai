// Legal Agent — Generate a complete legal document via Claude
// POST { type, brief, variables?, related_contact?, related_contact_email? }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const TYPE_LABELS: Record<string, string> = {
  cdi: "Contrat de travail à durée indéterminée (CDI)",
  cdd: "Contrat de travail à durée déterminée (CDD)",
  contrat_prestation: "Contrat de prestation de services",
  contrat_commercial: "Contrat commercial B2B",
  contrat_freelance: "Contrat freelance",
  nda: "Accord de confidentialité (NDA)",
  cgv: "Conditions Générales de Vente",
  cgu: "Conditions Générales d'Utilisation",
  mentions_legales: "Mentions légales",
  politique_confidentialite: "Politique de confidentialité RGPD",
  registre_traitement: "Registre des traitements RGPD",
  pia: "Analyse d'impact relative à la protection des données (PIA)",
  statuts_sasu: "Statuts d'une SASU",
  statuts_sas: "Statuts d'une SAS",
  statuts_sarl: "Statuts d'une SARL",
  statuts_sci: "Statuts d'une SCI",
  pv_ag: "Procès-verbal d'Assemblée Générale",
  pv_nomination: "PV de nomination",
  pv_non_remuneration: "PV de non-rémunération du président",
  pv_approbation_comptes: "PV d'approbation des comptes",
  pacte_associes: "Pacte d'associés",
  convention_cca: "Convention de compte courant d'associé",
  cession_parts: "Acte de cession de parts sociales",
  bail_habitation: "Bail d'habitation (loi du 6 juillet 1989)",
  bail_commercial: "Bail commercial (statut 3-6-9)",
  bail_professionnel: "Bail professionnel",
  mise_en_demeure: "Mise en demeure de payer (LRAR)",
  injonction_payer: "Requête en injonction de payer",
  lettre_resiliation: "Lettre de résiliation",
  lettre_contestation: "Lettre de contestation",
  lettre_reclamation: "Lettre de réclamation",
  lettre_demission: "Lettre de démission",
  rupture_conventionnelle: "Demande de rupture conventionnelle",
  custom: "Document personnalisé",
};

const TYPE_TO_CATEGORY: Record<string, string> = {
  cdi: "contrats", cdd: "contrats", contrat_prestation: "contrats",
  contrat_commercial: "contrats", contrat_freelance: "contrats", nda: "contrats",
  cgv: "web", cgu: "web", mentions_legales: "web",
  politique_confidentialite: "web", registre_traitement: "web", pia: "web",
  statuts_sasu: "entreprise", statuts_sas: "entreprise", statuts_sarl: "entreprise",
  statuts_sci: "entreprise", pv_ag: "entreprise", pv_nomination: "entreprise",
  pv_non_remuneration: "entreprise", pv_approbation_comptes: "entreprise",
  pacte_associes: "entreprise", convention_cca: "entreprise", cession_parts: "entreprise",
  bail_habitation: "immobilier", bail_commercial: "immobilier", bail_professionnel: "immobilier",
  mise_en_demeure: "recouvrement", injonction_payer: "recouvrement",
  lettre_resiliation: "vie_courante", lettre_contestation: "vie_courante", lettre_reclamation: "vie_courante",
  lettre_demission: "travail", rupture_conventionnelle: "travail",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const token = auth.replace("Bearer ", "");

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      db: { schema: "purama_ai" },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;

    const body = (await req.json()) as {
      type?: string;
      brief?: string;
      variables?: Record<string, unknown>;
      related_contact?: string;
      related_contact_email?: string;
    };
    if (!body.type || !body.brief) return json({ error: "type and brief required" }, 400);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      db: { schema: "purama_ai" },
    });

    // Fetch user profile for context
    const { data: cfg } = await admin
      .from("legal_agent_config")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    const typeLabel = TYPE_LABELS[body.type] ?? body.type;
    const profileContext = cfg
      ? `Entreprise: ${cfg.company_name ?? "—"} (${cfg.user_type})
SIREN: ${cfg.siren ?? "—"}
Adresse: ${cfg.address ?? "—"}, ${cfg.postal_code ?? ""} ${cfg.city ?? ""}
Activité: ${cfg.activity_description ?? "—"}`
      : "(profil non renseigné)";

    const systemPrompt = `Tu es un avocat français expert. Tu rédiges un document juridique COMPLET, conforme au droit français en vigueur, prêt à signer.

Profil de l'émetteur :
${profileContext}

Tu dois retourner UNIQUEMENT un JSON valide :
{
  "title": "Titre du document",
  "content_html": "<contenu Markdown complet du document>",
  "ai_analysis": "Analyse courte des points-clés et recommandations",
  "expires_at": "YYYY-MM-DD ou null si pas applicable",
  "requires_signature": true/false
}

Le content_html doit être au format **Markdown** (pas du HTML strict — c'est rendu via react-markdown). Inclure :
- Titre du document
- Identité des parties (utiliser le profil émetteur, et la contrepartie si fournie)
- Toutes les clauses légalement requises
- Articles numérotés
- Bloc signature à la fin
- Mentions légales obligatoires
- Citations exactes des textes (Code, articles)
- Aucun placeholder type [INSÉRER X] : si une info manque, utiliser une valeur par défaut raisonnable et le mentionner dans ai_analysis.`;

    const userMessage = `Type: ${typeLabel}
Contrepartie: ${body.related_contact ?? "(à définir)"} ${body.related_contact_email ? `<${body.related_contact_email}>` : ""}

Demande:
${body.brief}

${body.variables ? `Variables fournies: ${JSON.stringify(body.variables)}` : ""}

Génère le document complet maintenant.`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    if (!claudeRes.ok) {
      const t = await claudeRes.text();
      return json({ error: "Claude failed", details: t }, 502);
    }
    const claudeJson = await claudeRes.json() as { content: Array<{ text: string }> };
    const raw = claudeJson.content?.[0]?.text ?? "{}";
    let parsed: { title: string; content_html: string; ai_analysis?: string; expires_at?: string | null; requires_signature?: boolean } = {
      title: typeLabel, content_html: "",
    };
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : raw);
    } catch (e) {
      console.error("[legal-generate] parse error", e);
      // Fallback: use the raw content as the document
      parsed = { title: typeLabel, content_html: raw, ai_analysis: "Document généré (parsing JSON échoué, contenu brut)", requires_signature: false };
    }

    const { data: doc, error: insErr } = await admin
      .from("legal_documents")
      .insert({
        user_id: userId,
        title: parsed.title || typeLabel,
        type: body.type,
        category: TYPE_TO_CATEGORY[body.type] ?? "autre",
        status: "draft",
        content_html: parsed.content_html,
        user_brief: body.brief,
        ai_analysis: parsed.ai_analysis ?? null,
        variables: body.variables ?? {},
        requires_signature: parsed.requires_signature ?? false,
        related_contact: body.related_contact ?? null,
        related_contact_email: body.related_contact_email ?? null,
        expires_at: parsed.expires_at ?? null,
      })
      .select()
      .single();
    if (insErr) throw insErr;

    return json(doc);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[legal-generate-document]", msg);
    return json({ error: msg }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
