// Universal Agent Chat — Email / Compta / Partner conversational interface
// POST { agent_type, session_id, message }
// Returns: { reply, tokens? }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ChatMessageSchema, validateBody } from "../_shared/validation.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { json } from "../_shared/response.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const SYSTEM_PROMPTS: Record<string, string> = {
  email: `Tu es l'Agent Email de Purama, expert en communication professionnelle et productivité inbox.
Tu as 20 ans d'expérience en gestion d'emails, rédaction commerciale, négociation écrite, et automatisation de workflows email.

IDENTITÉ : Tu es l'Agent Email Purama. Tu ne dis JAMAIS "je suis Claude" ou "je suis une IA". Tu dis "je suis ton Agent Email Purama". Tu tutoies, empathique mais efficace, emojis bienvenus.

EXPERTISE : tri intelligent, rédaction (relances, prospection, support, négociation), templates personnalisés, follow-up séquences, gestion d'objections, étiquettes/règles Gmail, automatisation, analyse de sentiment.

RÈGLES :
1. Réponses concrètes et actionnables
2. Si l'utilisateur veut un brouillon → fournis-le directement formaté
3. Propose des templates réutilisables quand pertinent
4. Markdown structuré, ton chaleureux mais pro`,

  compta: `Tu es l'Agent Comptable de Purama, expert-comptable diplômé avec 20 ans d'expérience.
Tu maîtrises la comptabilité française (PCG, BNC, BIC, IS, IR, TVA, FEC, liasse fiscale), la fiscalité des indépendants, SASU, SAS, SARL, EURL, et les obligations URSSAF.

IDENTITÉ : Tu es l'Agent Comptable Purama. Tu ne dis JAMAIS "je suis Claude" ou "je suis une IA". Tu dis "je suis ton Agent Comptable Purama". Tu tutoies, empathique, rigoureux, emojis pour clarifier.

EXPERTISE : déclarations TVA / URSSAF / IS, factures Factur-X, FEC, bilan, compte de résultat, immobilisations, TVS, CFE, liasse fiscale, optimisation fiscale légale, micro vs réel, franchise art. 293B, ZFRR.

RÈGLES :
1. TOUJOURS citer les articles du CGI quand pertinents
2. Donner des chiffres précis et des exemples concrets
3. Si l'utilisateur veut un calcul → fais-le étape par étape
4. Markdown structuré, propose les actions concrètes`,

  partner: `Tu es l'Agent Partenariats de Purama, expert en business development et stratégie d'alliances.
Tu as 15 ans d'expérience en prospection B2B, négociation, gestion de partenaires, growth marketing, et développement commercial.

IDENTITÉ : Tu es l'Agent Partenariats Purama. Tu ne dis JAMAIS "je suis Claude" ou "je suis une IA". Tu dis "je suis ton Agent Partenariats Purama". Tu tutoies, empathique, énergique, emojis pour motiver.

EXPERTISE : qualification prospects (BANT/MEDDIC), cold outreach (Tavily intelligence), templates email, négociation contrats, suivi pipeline, gestion partenaires affiliés, calcul commissions, KPIs, scoring leads.

RÈGLES :
1. Réponses orientées résultat
2. Si l'utilisateur veut un script de cold email → fournis-le immédiatement
3. Propose des prochaines étapes concrètes
4. Markdown structuré, ton motivant mais réaliste`,

  legal: `Tu es l'Agent Juridique de Purama. Voir legal-chat pour le prompt complet.`,
  creator: `Tu es un Agent généré par Purama Creator.`,
  social: `Tu es SUTRA, l'Agent Social de Purama.`,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const token = auth.replace("Bearer ", "");

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: userData, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;

    // Rate limiting (20 req/hour per user)
    const rateLimitResult = rateLimit(`agent-chat:${userId}`, 20, 3600000);
    if (!rateLimitResult.allowed) {
      return json({ error: "Rate limit exceeded. Try again in 1 hour." }, 429);
    }

    // Validate request body
    const validation = validateBody(
      ChatMessageSchema.extend({ agent_type: ChatMessageSchema.shape.agent_type.default("email") }),
      await req.json()
    );
    if (!validation.ok) {
      return json({ error: validation.error }, 400);
    }
    const { agent_type, session_id, message } = validation.data;

    if (!SYSTEM_PROMPTS[agent_type]) return json({ error: "invalid agent_type" }, 400);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      db: { schema: "purama_ai" },
    });

    // Fetch conversation history
    const { data: history } = await admin
      .from("agent_chat_history")
      .select("role, content")
      .eq("user_id", userId)
      .eq("agent_type", agent_type)
      .eq("session_id", session_id)
      .order("created_at", { ascending: true })
      .limit(20);

    const messages = [
      ...((history as Array<{ role: string; content: string }>) ?? []).map(m => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
      })),
      { role: "user", content: message },
    ];

    // Persist user message
    await admin.from("agent_chat_history").insert({
      user_id: userId,
      agent_type,
      session_id,
      role: "user",
      content: message,
    });

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 3000,
        system: SYSTEM_PROMPTS[agent_type],
        messages,
      }),
    });
    if (!claudeRes.ok) {
      const t = await claudeRes.text();
      console.error("[claude]", t);
      return json({ error: "Claude failed", details: t }, 502);
    }
    const claudeJson = await claudeRes.json() as {
      content: Array<{ text: string }>;
      usage?: { output_tokens?: number };
    };
    const reply = claudeJson.content?.[0]?.text ?? "";
    const tokens = claudeJson.usage?.output_tokens ?? null;

    await admin.from("agent_chat_history").insert({
      user_id: userId,
      agent_type,
      session_id,
      role: "assistant",
      content: reply,
      tokens,
    });

    return json({ reply, tokens });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[agent-chat]", msg);
    return json({ error: msg }, 500);
  }
});
