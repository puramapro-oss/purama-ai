// Creator Agent — Chat with a custom user agent
// POST { agent_id, session_id, message }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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

    const { agent_id, session_id, message } = (await req.json()) as {
      agent_id?: string; session_id?: string; message?: string;
    };
    if (!agent_id || !session_id || !message) {
      return json({ error: "agent_id, session_id, message required" }, 400);
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      db: { schema: "purama_ai" },
    });

    // Fetch agent — must be owned by user (templates not chattable directly)
    const { data: agent, error: aErr } = await admin
      .from("creator_agents")
      .select("*")
      .eq("id", agent_id)
      .single();
    if (aErr || !agent) return json({ error: "Agent not found" }, 404);
    if (agent.user_id !== userId && !agent.is_public) {
      return json({ error: "Forbidden" }, 403);
    }

    // Fetch chat history (last 20 turns) for this session
    const { data: history } = await admin
      .from("creator_agent_chats")
      .select("role, content")
      .eq("agent_id", agent_id)
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
    await admin.from("creator_agent_chats").insert({
      user_id: userId,
      agent_id,
      session_id,
      role: "user",
      content: message,
    });

    const t0 = Date.now();
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: agent.model,
        max_tokens: agent.max_tokens,
        temperature: Number(agent.temperature),
        system: agent.system_prompt,
        messages,
      }),
    });
    if (!claudeRes.ok) {
      const t = await claudeRes.text();
      console.error("[creator-chat] claude", t);
      return json({ error: "Claude failed", details: t }, 502);
    }
    const claudeJson = await claudeRes.json() as {
      content: Array<{ text: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };
    const reply = claudeJson.content?.[0]?.text ?? "";
    const tokensIn = claudeJson.usage?.input_tokens ?? 0;
    const tokensOut = claudeJson.usage?.output_tokens ?? 0;
    const duration = Date.now() - t0;

    // Persist assistant message
    await admin.from("creator_agent_chats").insert({
      user_id: userId,
      agent_id,
      session_id,
      role: "assistant",
      content: reply,
      tokens: tokensOut,
    });

    // Persist a run row + bump stats
    await admin.from("creator_agent_runs").insert({
      user_id: userId,
      agent_id,
      trigger: "chat",
      input: message,
      output: reply,
      status: "success",
      tokens_input: tokensIn,
      tokens_output: tokensOut,
      duration_ms: duration,
    });

    // Bump aggregate counters
    await admin
      .from("creator_agents")
      .update({
        total_runs: agent.total_runs + 1,
        total_tokens: agent.total_tokens + tokensIn + tokensOut,
      })
      .eq("id", agent_id);

    return json({ reply, tokens: tokensOut });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[creator-agent-chat]", msg);
    return json({ error: msg }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
