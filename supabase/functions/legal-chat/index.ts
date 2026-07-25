// Legal Agent — Conversational chat with Claude
// POST { session_id, message }
// 1. Fetch user profile + recent conversation history
// 2. Build system prompt (legal expert)
// 3. Call Claude with full context
// 4. Persist user + assistant messages in legal_chat_history
// 5. Return reply + sources extracted from the response
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { validateBody } from "../_shared/validation.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { json } from "../_shared/response.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const LegalChatSchema = z.object({
  session_id: z.string().uuid(),
  message: z.string().min(1).max(4000),
});

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const SYSTEM_PROMPT_BASE = `Tu es l'Agent Juridique de Purama, le meilleur juriste IA au monde.
Tu as l'expertise combinée d'un avocat d'affaires, d'un fiscaliste, d'un pénaliste, d'un spécialiste du droit du travail, et d'un expert RGPD, avec 30 ans d'expérience chacun.

IDENTITÉ : Tu es l'Agent Juridique Purama. Tu ne dis JAMAIS "je suis Claude" ou "je suis une IA". Tu dis "je suis votre assistant juridique Purama". Tu tutoies l'utilisateur. Empathique mais précis.

EXPERTISE PARFAITE : Code civil, Code de commerce, Code du travail, Code pénal, Code de procédure civile, droit des sociétés, droit fiscal, droit immobilier, RGPD, propriété intellectuelle, droit de la consommation, droit de la famille, jurisprudence Cour de cassation / Conseil d'État / CJUE / CEDH.

RÈGLES :
1. TOUJOURS citer les textes de loi exacts (articles, numéros, codes)
2. TOUJOURS mentionner la jurisprudence pertinente quand elle existe
3. TOUJOURS donner une réponse concrète et actionnable
4. Si incertitude → présenter les deux interprétations avec probabilités
5. JAMAIS de conseil dangereux ou illégal
6. Pour les documents → propose de les générer immédiatement
7. Réponse structurée Markdown : (1) Réponse directe (2) Base légale (3) Recommandation (4) Risques

À LA FIN DE TA RÉPONSE, ajoute une section "## Sources" qui liste les références citées au format Markdown link, ex:
## Sources
- [Art. L1234-9 du Code du travail](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000019071218)
- [Cass. soc. 25 novembre 2020, n° 19-12.665](https://www.courdecassation.fr/...)`;

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

    // Rate limiting (20 req/hour)
    const rateLimitResult = rateLimit(`legal-chat:${userId}`, 20, 3600000);
    if (!rateLimitResult.allowed) {
      return json({ error: "Rate limit exceeded. Try again in 1 hour." }, 429);
    }

    // Validate input
    const validation = validateBody(LegalChatSchema, await req.json());
    if (!validation.ok) {
      return json({ error: validation.error }, 400);
    }
    const { session_id, message } = validation.data;

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      db: { schema: "purama_ai" },
    });

    // Fetch profile + history in parallel
    const [{ data: cfg }, { data: history }] = await Promise.all([
      admin.from("legal_agent_config").select("*").eq("user_id", userId).maybeSingle(),
      admin
        .from("legal_chat_history")
        .select("role, content")
        .eq("user_id", userId)
        .eq("session_id", session_id)
        .order("created_at", { ascending: true })
        .limit(20),
    ]);

    const profileBlock = cfg
      ? `<profil_utilisateur>
Type : ${cfg.user_type}
Entreprise : ${cfg.company_name ?? "—"} ${cfg.siren ? `(${cfg.siren})` : ""}
Activité : ${cfg.activity_description ?? "—"}
Salariés : ${cfg.employee_count ?? 0}
Zone : ${cfg.city ?? "—"} ${cfg.postal_code ?? ""}
Domaines suivis : ${(cfg.expertise_areas ?? []).join(", ")}
</profil_utilisateur>`
      : "";

    const systemPrompt = `${SYSTEM_PROMPT_BASE}\n\n${profileBlock}`;

    // Build messages array (history + new user message)
    const messages = [
      ...((history as Array<{ role: string; content: string }>) ?? []).map(m => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
      })),
      { role: "user", content: message },
    ];

    // Persist user message
    await admin.from("legal_chat_history").insert({
      user_id: userId,
      session_id,
      role: "user",
      content: message,
    });

    // Call Claude
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
        messages,
      }),
    });
    if (!claudeRes.ok) {
      const t = await claudeRes.text();
      console.error("[claude]", t);
      return json({ error: "Claude failed", details: t }, 502);
    }
    const claudeJson = await claudeRes.json() as { content: Array<{ text: string }> };
    const reply = claudeJson.content?.[0]?.text ?? "";

    // Extract sources from the markdown "## Sources" section
    const sources: Array<{ type: string; reference: string; url?: string }> = [];
    const sourcesMatch = reply.match(/##\s*Sources\s*\n([\s\S]*?)(?=\n##|$)/);
    if (sourcesMatch) {
      const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
      let m;
      while ((m = linkRe.exec(sourcesMatch[1])) !== null) {
        sources.push({ type: "law", reference: m[1], url: m[2] });
      }
      // Also pick plain references like "- Art. L1234-9"
      const plainRe = /^-\s+([^[\n]+)$/gm;
      while ((m = plainRe.exec(sourcesMatch[1])) !== null) {
        const ref = m[1].trim();
        if (ref && !sources.find(s => s.reference === ref)) {
          sources.push({ type: "law", reference: ref });
        }
      }
    }

    // Persist assistant message
    await admin.from("legal_chat_history").insert({
      user_id: userId,
      session_id,
      role: "assistant",
      content: reply,
      sources_cited: sources,
    });

    return json({ reply, sources });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[legal-chat]", msg);
    return json({ error: msg }, 500);
  }
});
