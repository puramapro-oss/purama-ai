// Creator Agent — One-shot run (manual trigger or n8n cron)
// POST { agent_id, input, trigger?: "manual"|"cron"|"webhook"|"api" }
// If called by service-role: bypass user check (used by n8n scheduler).
// If called by user JWT: must own the agent.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AgentRunSchema, validateBody } from "../_shared/validation.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { json } from "../_shared/response.ts";

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

    // Detect service-role token (used by n8n cron)
    const isServiceRole = token === SUPABASE_SERVICE_ROLE_KEY;

    let userId: string | null = null;
    if (!isServiceRole) {
      const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        db: { schema: "purama_ai" },
      });
      const { data: userData, error: userErr } = await userClient.auth.getUser(token);
      if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
      userId = userData.user.id;

      // Rate limiting (10 req/hour for manual runs)
      const rateLimitResult = rateLimit(`creator-agent-run:${userId}`, 10, 3600000);
      if (!rateLimitResult.allowed) {
        return json({ error: "Rate limit exceeded. Try again in 1 hour." }, 429);
      }
    }

    // Validate input
    const validation = validateBody(AgentRunSchema, await req.json());
    if (!validation.ok) {
      return json({ error: validation.error }, 400);
    }
    const { agent_id, input } = validation.data;

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      db: { schema: "purama_ai" },
    });

    // Fetch agent
    const { data: agent, error: aErr } = await admin
      .from("creator_agents")
      .select("*")
      .eq("id", agent_id)
      .single();
    if (aErr || !agent) return json({ error: "Agent not found" }, 404);

    // Authorization
    if (!isServiceRole && agent.user_id !== userId) {
      return json({ error: "Forbidden" }, 403);
    }
    if (!agent.is_active) {
      return json({ error: "Agent is paused" }, 400);
    }

    const effectiveUserId = userId ?? agent.user_id;
    if (!effectiveUserId) return json({ error: "Cannot determine user" }, 400);

    const trigger = (validation.data.trigger as string) || "manual";
    const inputText = (input ?? "") as string;

    // Insert pending run row
    const { data: runRow, error: runErr } = await admin
      .from("creator_agent_runs")
      .insert({
        user_id: effectiveUserId,
        agent_id: agent.id,
        trigger,
        input: inputText,
        status: "running",
      })
      .select()
      .single();
    if (runErr) throw runErr;

    const t0 = Date.now();
    try {
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
          messages: [{ role: "user", content: inputText || "Démarre." }],
        }),
      });
      if (!claudeRes.ok) {
        const t = await claudeRes.text();
        throw new Error(`Claude ${claudeRes.status}: ${t.slice(0, 200)}`);
      }
      const claudeJson = await claudeRes.json() as {
        content: Array<{ text: string }>;
        usage: { input_tokens: number; output_tokens: number };
      };
      const output = claudeJson.content?.[0]?.text ?? "";
      const tokensIn = claudeJson.usage?.input_tokens ?? 0;
      const tokensOut = claudeJson.usage?.output_tokens ?? 0;
      const duration = Date.now() - t0;

      const { data: updated } = await admin
        .from("creator_agent_runs")
        .update({
          output,
          status: "success",
          tokens_input: tokensIn,
          tokens_output: tokensOut,
          duration_ms: duration,
        })
        .eq("id", runRow.id)
        .select()
        .single();

      await admin
        .from("creator_agents")
        .update({
          total_runs: agent.total_runs + 1,
          total_tokens: agent.total_tokens + tokensIn + tokensOut,
          last_scheduled_run: trigger === "cron" ? new Date().toISOString() : agent.last_scheduled_run,
        })
        .eq("id", agent.id);

      return json(updated);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await admin
        .from("creator_agent_runs")
        .update({
          status: "error",
          error_message: msg,
          duration_ms: Date.now() - t0,
        })
        .eq("id", runRow.id);
      return json({ error: msg }, 502);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[creator-agent-run]", msg);
    return json({ error: msg }, 500);
  }
});
