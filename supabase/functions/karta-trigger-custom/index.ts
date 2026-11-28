import { createClient } from "npm:@supabase/supabase-js@2.119.2";
import { rateLimit } from "../_shared/rate-limit.ts";
import { readBoundedBytes, RequestBodyError } from "../_shared/request-body.ts";
import { cancelResponseQuietly, createRequestDeadline, RequestDeadlineError } from "../_shared/request-deadline.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_BODY_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 16_384;
const TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_ID = /^karta-v2-dedupe-[0-9a-f]{64}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Forward one owner-authorized intention through the existing KARTA protocol.
 * No retry is automatic: a lost acknowledgement must retain its requestId. */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);
  if (req.signal.aborted) return json({ error: "Demande annulée ; son admission reste à vérifier." }, 499);
  const controller = new AbortController();
  const endsAt = performance.now() + TIMEOUT_MS;
  const deadline = createRequestDeadline(TIMEOUT_MS, req.signal);
  let response: Response | undefined;
  let forwarding = false;
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !/^Bearer [^\s]+$/i.test(authHeader)) return json({ error: "Non autorisé" }, 401);
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !supabaseKey) {
      console.error("karta-trigger-custom: authentication configuration unavailable");
      return json({ error: "Service temporairement indisponible" }, 503);
    }
    const client = createClient(supabaseUrl, supabaseKey, {
      db: { schema: "purama_ai" },
      global: {
        headers: { Authorization: authHeader },
        fetch: (input, init) => fetch(input, { ...init, signal: controller.signal, redirect: "error" }),
      },
    });
    const { data, error: authError } = await deadline.wait(() => client.auth.getUser(authHeader.slice(7)));
    if (authError || !data?.user || !UUID.test(data.user.id)) return json({ error: "Non autorisé" }, 401);
    const userId = data.user.id.toLowerCase();
    let body: unknown;
    try {
      const bytes = await deadline.wait(() => readBoundedBytes(req, { maxBytes: MAX_BODY_BYTES, deadline: endsAt }));
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      deadline.check();
    } catch (error) {
      deadline.check();
      if (error instanceof RequestBodyError && error.status === 408) throw error;
      return json({ error: error instanceof RequestBodyError && error.status === 413 ? "Requête trop volumineuse" : "Demande invalide" },
        error instanceof RequestBodyError && error.status === 413 ? 413 : 400);
    }
    if (!record(body) || Object.keys(body).some(key => key !== "agentId" && key !== "requestId")
      || typeof body.agentId !== "string" || !UUID.test(body.agentId)
      || typeof body.requestId !== "string" || !UUID.test(body.requestId)) return json({ error: "Demande invalide" }, 400);
    const agentId = body.agentId.toLowerCase();
    const requestId = body.requestId.toLowerCase();
    if (!rateLimit(`karta-trigger-custom:${userId}`, 10, 3_600_000).allowed) {
      return json({ error: "Trop de déclenchements. Réessaie dans un moment." }, 429);
    }
    const { data: agent, error: agentError } = await deadline.wait(async () => await client.from("creator_agents")
      .select("id, user_id, karta_enabled").eq("id", agentId).abortSignal(controller.signal).maybeSingle());
    if (agentError) return json({ error: "Vérification de l’agent temporairement indisponible" }, 503);
    if (!agent || agent.id !== agentId) return json({ error: "Agent introuvable" }, 404);
    if (agent.user_id !== userId) return json({ error: "Accès refusé" }, 403);
    if (agent.karta_enabled !== true) return json({ error: "L’exécution de cet agent n’est pas activée" }, 400);

    const kartaUrl = Deno.env.get("KARTA_INTERNAL_URL");
    const kartaToken = Deno.env.get("KARTA_ADMIN_TOKEN");
    let target: URL;
    try {
      if (!kartaUrl || !kartaToken) throw new Error();
      target = new URL(kartaUrl);
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error();
      // An older API cannot match this owner-bound route. Never fall back to
      // its administrative route when the required contract is unavailable.
      target.pathname = `${target.pathname.replace(/\/+$/, "")}/trigger-custom/${agentId}/owner/${userId}`;
    } catch {
      console.error("karta-trigger-custom: internal configuration unavailable or invalid");
      return json({ error: "Service temporairement indisponible" }, 503);
    }
    deadline.check();
    forwarding = true;
    response = await deadline.fetch(target, {
      method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${kartaToken}`, "Content-Type": "application/json", "Idempotency-Key": requestId },
    });
    if (response.status !== 202) throw new Error();
    const bytes = await deadline.wait(() => readBoundedBytes({
      headers: response!.headers, body: response!.body, signal: controller.signal,
    }, { maxBytes: MAX_RESPONSE_BYTES, deadline: endsAt, matchContentLength: false }));
    const receipt: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    deadline.check();
    if (!record(receipt) || receipt.ok !== true || receipt.queued !== true
      || typeof receipt.jobId !== "string" || !JOB_ID.test(receipt.jobId)
      || receipt.executionKey !== `queue:v2:${receipt.jobId}`) throw new Error();
    // Only canonical queue metadata crosses the boundary, never raw provider fields.
    return json({ ok: true, queued: true, requestId, jobId: receipt.jobId, executionKey: receipt.executionKey }, 202);
  } catch (error) {
    if (req.signal.aborted) return json({ error: "Demande annulée ; son admission reste à vérifier." }, 499);
    if (error instanceof RequestDeadlineError || error instanceof RequestBodyError && error.status === 408) {
      return json({ error: "Délai dépassé. Réessaie le même envoi ou consulte l’activité de cet agent." }, 504);
    }
    console.error("karta-trigger-custom: request unavailable or response invalid");
    return json({ error: forwarding ? "Déclenchement non confirmé. Réessaie le même envoi ou consulte l’activité de cet agent."
      : "Service temporairement indisponible" }, forwarding ? 502 : 503);
  } finally {
    controller.abort();
    deadline.close();
    cancelResponseQuietly(response?.body);
  }
});
