import { readCompletedAssistantReply } from "../_shared/assistant-response.ts";
import { buildAssistantSystemPrompt } from "../_shared/assistant-policy.ts";
// Universal Agent Chat — Email / Compta / Partner conversational interface
// POST { agent_type, session_id, message }
// Returns: { reply, tokens? }
import { createClient } from "npm:@supabase/supabase-js@2.91.0";
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
  email: `Tu es l'assistant IA Email de PURAMA. Aide au tri, à la rédaction et à l'organisation des emails. Fournis un brouillon utile lorsque demandé, en respectant le ton souhaité. Ce chat n'envoie aucun message.`,
  compta: `Tu es l'assistant IA Comptabilité de PURAMA. Aide à comprendre les comptes, faire des calculs et préparer les pièces. Explicite les hypothèses et distingue estimation et montant confirmé. Vérifie les règles, dates et sources disponibles; n'invente pas d'article fiscal. Une validation professionnelle peut être nécessaire pour un dépôt engageant.`,
  partner: `Tu es l'assistant IA Partenariats de PURAMA. Aide à préparer des propositions utiles, transparentes et adaptées à des besoins exprimés. Présente les contreparties, coûts et limites. Ne promets pas qu'un contact acceptera; n'exploite pas ses confidences ou vulnérabilités. Ce chat prépare du texte, sans démarcher ni contacter personne.`,
  legal: `Tu es l'assistant IA Juridique de PURAMA. Explique les informations disponibles, leurs limites et les points à vérifier auprès d'une source officielle ou d'un professionnel. Ne fabrique ni référence ni probabilité de succès.`,
  creator: `Tu es l'assistant IA de création de PURAMA. Aide à concevoir une tâche, un format et des limites explicites.`,
  social: `Tu es SUTRA, l'assistant IA Social de PURAMA. Aide à rédiger un contenu honnête et respectueux, sans publier dans ce chat.`,
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
    const { data: history, error: historyError } = await admin
      .from("agent_chat_history")
      .select("role, content")
      .eq("user_id", userId)
      .eq("agent_type", agent_type)
      .eq("session_id", session_id)
      .order("created_at", { ascending: false })
      .limit(20);

    if (historyError) return json({ error: "L'historique est temporairement indisponible. Réessaie sans perdre ta conversation." }, 503);
    req.signal.throwIfAborted();

    const messages = [
      ...[...((history as Array<{ role: string; content: string }>) ?? [])].reverse().map(m => ({
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
      signal: req.signal,
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: Deno.env.get("ANTHROPIC_MODEL_MAIN") ?? "claude-sonnet-4-6",
        max_tokens: 3000,
        system: buildAssistantSystemPrompt(SYSTEM_PROMPTS[agent_type], "conversation"),
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
    req.signal.throwIfAborted();
    const completed = readCompletedAssistantReply(claudeJson);
    if (completed.ok === false) return json({
      error: "La réponse de l’IA est incomplète ou indisponible. Réessaie sans la considérer comme terminée.",
      code: "INCOMPLETE_AI_RESPONSE",
    }, 502);
    const reply = completed.text;
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
