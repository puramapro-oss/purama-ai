// Creator Agent — Generate a custom agent definition from a natural language description
// POST { description }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

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
  "suggested_tools": [],
  "suggested_model": "claude-sonnet-4-20250514 ou claude-haiku-4-5-20251001 (haiku pour les tâches simples et répétitives)",
  "suggested_temperature": 0.0 à 1.0 (0.3 = factuel, 0.7 = équilibré, 0.9 = créatif),
  "suggested_schedule": "expression cron OU null si pas pertinent"
}

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
      suggested_tools: Array.isArray(parsed.suggested_tools) ? parsed.suggested_tools : [],
      suggested_model: parsed.suggested_model === "claude-haiku-4-5-20251001"
        ? "claude-haiku-4-5-20251001"
        : "claude-sonnet-4-20250514",
      suggested_temperature: Math.max(0, Math.min(1, Number(parsed.suggested_temperature ?? 0.7))),
      suggested_schedule: parsed.suggested_schedule ?? null,
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
