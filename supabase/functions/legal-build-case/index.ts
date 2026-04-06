// Legal Agent — Build a complete case file from facts (Claude)
// POST { title, type, facts, parties }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
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
    const userId = userData.user.id;

    const body = (await req.json()) as {
      title?: string;
      type?: string;
      facts?: string;
      parties?: Array<{ name: string; role: string; email?: string }>;
    };
    if (!body.title || !body.facts || !body.type) {
      return json({ error: "title, type and facts required" }, 400);
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      db: { schema: "purama_ai" },
    });

    const { data: cfg } = await admin
      .from("legal_agent_config")
      .select("user_type,company_name,siren,activity_description,city,postal_code")
      .eq("user_id", userId)
      .maybeSingle();

    const profileContext = cfg
      ? `Profil client: ${cfg.user_type} ${cfg.company_name ?? ""} ${cfg.siren ? `SIREN ${cfg.siren}` : ""}, ${cfg.city ?? ""}`
      : "";

    const systemPrompt = `Tu es un avocat français spécialisé. Tu reçois un dossier brut et tu dois le monter complètement en analysant la situation, identifiant la stratégie, les arguments, les risques, la jurisprudence, et la probabilité de succès.

Tu retournes UNIQUEMENT un JSON valide :
{
  "ai_analysis": "Analyse complète du dossier en 3-5 paragraphes",
  "ai_strategy": "Stratégie recommandée étape par étape",
  "ai_arguments": ["Argument 1", "Argument 2", ...],
  "ai_risks": ["Risque 1", "Risque 2", ...],
  "ai_jurisprudence": [
    { "reference": "Cass. soc. 25 nov. 2020, n° 19-12.665", "court": "Cour de cassation", "date": "2020-11-25", "summary": "...", "relevance": "Pertinent car..." }
  ],
  "ai_success_probability": 75,
  "ai_estimated_amount": 12500,
  "deadlines": [{"date":"2026-06-30","description":"Délai de réponse","type":"procedure"}],
  "prescription_date": "2027-04-06",
  "prescription_type": "Action en paiement (5 ans, art. 2224 C. civ.)",
  "priority": "normal"
}

Sois précis, cite les articles de loi exacts dans les arguments, et donne des montants réalistes.`;

    const userMessage = `${profileContext}

Type de dossier : ${body.type}
Titre : ${body.title}

Parties :
${(body.parties ?? []).map(p => `- ${p.name} (${p.role})${p.email ? ` <${p.email}>` : ""}`).join("\n")}

Faits :
${body.facts}

Monte ce dossier maintenant.`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
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
    let analysis: Record<string, unknown> = {};
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      analysis = JSON.parse(m ? m[0] : raw);
    } catch (e) {
      console.error("[legal-build-case] parse", e);
      analysis = { ai_analysis: raw };
    }

    const { data: row, error: insErr } = await admin
      .from("legal_cases")
      .insert({
        user_id: userId,
        title: body.title,
        type: body.type,
        status: "open",
        priority: (analysis.priority as string) || "normal",
        parties: body.parties ?? [],
        facts: body.facts,
        ai_analysis: (analysis.ai_analysis as string) ?? null,
        ai_strategy: (analysis.ai_strategy as string) ?? null,
        ai_arguments: (analysis.ai_arguments as string[]) ?? [],
        ai_risks: (analysis.ai_risks as string[]) ?? [],
        ai_jurisprudence: (analysis.ai_jurisprudence as unknown[]) ?? [],
        ai_success_probability: (analysis.ai_success_probability as number) ?? null,
        ai_estimated_amount: (analysis.ai_estimated_amount as number) ?? null,
        deadlines: (analysis.deadlines as unknown[]) ?? [],
        prescription_date: (analysis.prescription_date as string) ?? null,
        prescription_type: (analysis.prescription_type as string) ?? null,
      })
      .select()
      .single();
    if (insErr) throw insErr;

    return json(row);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[legal-build-case]", msg);
    return json({ error: msg }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
