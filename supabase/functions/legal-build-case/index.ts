import { buildAssistantSystemPrompt } from "../_shared/assistant-policy.ts";
// Legal Agent — Build a complete case file from facts (Claude)
// POST { title, type, facts, parties }
import { createClient } from "npm:@supabase/supabase-js@2.91.0";
import { z } from "npm:zod@4.6.7";
import { validateBody } from "../_shared/validation.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { json } from "../_shared/response.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BuildCaseSchema = z.object({
  title: z.string().min(1).max(200),
  type: z.string().min(1).max(50),
  facts: z.string().min(10).max(10000),
  parties: z.array(z.object({
    name: z.string().min(1).max(100),
    role: z.string().min(1).max(50),
    email: z.string().email().optional(),
  })).optional(),
});

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

    // Rate limiting (10 req/hour)
    const rateLimitResult = rateLimit(`legal-build-case:${userId}`, 10, 3600000);
    if (!rateLimitResult.allowed) {
      return json({ error: "Rate limit exceeded. Try again in 1 hour." }, 429);
    }

    // Validate input
    const validation = validateBody(BuildCaseSchema, await req.json());
    if (!validation.ok) {
      return json({ error: validation.error }, 400);
    }
    const body = validation.data;

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

    const systemPrompt = `Tu es un assistant IA de préparation de dossier juridique. Analyse les faits fournis, les arguments, les pièces manquantes, les risques et les sources vérifiables. Ne te présente pas comme avocat; ne fabrique ni jurisprudence ni probabilité de succès.

Tu retournes UNIQUEMENT un JSON valide :
{
  "ai_analysis": "Analyse complète du dossier en 3-5 paragraphes",
  "ai_strategy": "Stratégie recommandée étape par étape",
  "ai_arguments": [],
  "ai_risks": [],
  "ai_jurisprudence": [],
  "ai_success_probability": null,
  "ai_estimated_amount": null,
  "deadlines": [],
  "prescription_date": null,
  "prescription_type": null,
  "priority": "normal"
}

Complète les arguments et risques à partir des faits fournis. Cite uniquement des références étayées. Les montants et délais inconnus restent null ou vides; n'invente pas les faits manquants. Explicite les calculs et hypothèses dans ai_analysis. ai_success_probability reste null: aucun modèle de probabilité validé n'est disponible.`;

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
        system: buildAssistantSystemPrompt(systemPrompt, "task"),
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
        // No calibrated outcome model supports a numerical legal success rate.
        ai_success_probability: null,
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
