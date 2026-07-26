// Creator Agent — Generate a custom agent definition from a natural language description
// POST { description }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { rateLimit } from "../_shared/rate-limit.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

// Liste blanche des outils réels que KARTA Engine sait exécuter pour un agent créé par un
// utilisateur (cf karta/src/tools/customRegistry.ts — 1 seule source de vérité, dupliquée ici
// car ce fichier tourne côté Deno, pas dans le projet karta/). Un nom hors de cette liste est
// filtré silencieusement plus bas : même si Claude en invente un, il ne sera jamais exécuté.
const REAL_TOOL_NAMES = [
  "supabase_select",
  "supabase_upsert",
  "gmail_create_draft",
  "gmail_send",
  "calendar_create_event",
  "generate_pdf",
  "web_search",
  "send_notification",
] as const;

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

    // 10 générations / heure / user : génération = 1 appel Claude assez lourd (2000 tokens), pas un usage répétitif.
    const rateLimitResult = rateLimit(`creator-agent-generate:${userData.user.id}`, 10, 3600000);
    if (!rateLimitResult.allowed) {
      return json({ error: "Trop de générations. Réessaie dans un moment." }, 429);
    }

    const { description } = (await req.json()) as { description?: string };
    if (!description) return json({ error: "description required" }, 400);

    const systemPrompt = `Tu es un architecte d'agents IA. L'utilisateur te décrit en français un agent qu'il aimerait avoir, et tu génères sa configuration complète.

Tu retournes UNIQUEMENT un JSON valide :
{
  "name": "Nom court et accrocheur (max 30 chars)",
  "slug": "slug-en-kebab-case",
  "emoji": "1 emoji représentatif",
  "color": "#hex couleur (palette: #8B5CF6 #06B6D4 #10B981 #F59E0B #EC4899 #EF4444 #6366F1 #14B8A6)",
  "category": "productivity|marketing|sales|support|content|dev|finance|autre",
  "description": "1 phrase courte (max 100 chars) qui décrit ce que fait l'agent",
  "system_prompt": "Le prompt système COMPLET que recevra Claude. Dois être : (1) précis sur le rôle et l'expertise, (2) inclure les contraintes (ton, format, longueur), (3) inclure 1-2 exemples implicites de structure attendue, (4) être autoporteur sans dépendre du contexte utilisateur. 200-500 mots idéalement.",
  "suggested_tools": ["0 à N noms d'outils, voir liste exacte ci-dessous"],
  "suggested_model": "claude-sonnet-4-20250514 ou claude-haiku-4-5-20251001 (haiku pour les tâches simples et répétitives)",
  "suggested_temperature": 0.0 à 1.0 (0.3 = factuel, 0.7 = équilibré, 0.9 = créatif),
  "suggested_schedule": "expression cron 5 champs (ex: '0 9 * * 1' = chaque lundi 9h, '0 8 * * *' = tous les jours 8h) SI l'utilisateur décrit une récurrence, sinon null (agent déclenché manuellement uniquement)"
}

Outils réels disponibles pour "suggested_tools" — utilise EXACTEMENT ces noms, aucun autre n'existe, choisis seulement ceux dont l'agent a vraiment besoin :
- supabase_select : lit les données déjà enregistrées par l'agent (factures, prospects, transactions...)
- supabase_upsert : enregistre/met à jour une donnée (un lead, un statut, une note...)
- gmail_create_draft : prépare un brouillon email Gmail, jamais envoyé sans validation
- gmail_send : envoie réellement un email — toujours soumis à validation humaine par défaut
- calendar_create_event : crée un événement Google Calendar
- generate_pdf : génère un PDF téléchargeable (rapport, facture, résumé...)
- web_search : recherche web en temps réel
- send_notification : notifie l'utilisateur (app/email) quand une décision humaine est nécessaire

Critères de qualité du system_prompt :
- Tutoiement par défaut sauf si l'utilisateur précise vouvoiement
- Démarre par "Tu es un [rôle expert] avec [crédibilité]"
- Inclut les contraintes de format : "Tu retournes...", "Tu structures...", "Tu utilises..."
- Inclut le ton et la voix
- Inclut les choses à NE PAS faire
- Pas de placeholders type [INSÉRER X]
- Optimise pour qu'au premier message l'agent soit déjà excellent`;

    const userMessage = `Description de l'utilisateur :
${description}

Génère la config de cet agent maintenant.`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
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
    let parsed: Record<string, unknown> = {};
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : raw);
    } catch (e) {
      console.error("[creator-generate] parse", e);
      return json({ error: "Claude response parse failed", raw }, 502);
    }

    // Defensive defaults
    const result = {
      name: String(parsed.name ?? "Mon agent").slice(0, 60),
      slug: String(parsed.slug ?? "agent").slice(0, 40),
      emoji: String(parsed.emoji ?? "🤖").slice(0, 4),
      color: String(parsed.color ?? "#8B5CF6"),
      category: ["productivity","marketing","sales","support","content","dev","finance","autre"].includes(parsed.category as string)
        ? parsed.category : "productivity",
      description: String(parsed.description ?? "").slice(0, 200),
      system_prompt: String(parsed.system_prompt ?? "Tu es un assistant IA utile."),
      // Liste blanche défensive : même si Claude invente un nom, il ne sera jamais exécutable côté KARTA.
      suggested_tools: Array.isArray(parsed.suggested_tools)
        ? parsed.suggested_tools.filter((t: unknown) => REAL_TOOL_NAMES.includes(t as typeof REAL_TOOL_NAMES[number]))
        : [],
      suggested_model: parsed.suggested_model === "claude-haiku-4-5-20251001"
        ? "claude-haiku-4-5-20251001"
        : "claude-sonnet-4-20250514",
      suggested_temperature: Math.max(0, Math.min(1, Number(parsed.suggested_temperature ?? 0.7))),
      // Validation légère (5 champs cron) — KARTA revalide avec cron.validate() avant toute
      // planification réelle, mais autant ne pas stocker de valeur manifestement invalide.
      suggested_schedule:
        typeof parsed.suggested_schedule === "string" && /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(parsed.suggested_schedule)
          ? parsed.suggested_schedule
          : null,
    };

    return json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[creator-agent-generate]", msg);
    return json({ error: msg }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
