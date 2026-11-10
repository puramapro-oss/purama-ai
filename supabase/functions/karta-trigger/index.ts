import { createClient } from "npm:@supabase/supabase-js@2.91.0";
import { rateLimit } from "../_shared/rate-limit.ts";
import { KartaTriggerSchema } from "../_shared/validation.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const missionStates = new Set([
  "pending", "claimed", "effect_started", "ready", "awaiting_approval", "completed", "reconciliation_required",
]);
const runStates = new Set([
  "running", "executing", "success", "error", "awaiting_approval", "skipped", "cancelled", "simulated", "partial",
]);
const publicErrors: Record<string, { status: number; error: string }> = {
  BRIEF_BUSY: { status: 409, error: "Une consigne attend déjà cet employé. Consulte son état avant une nouvelle mission." },
  BRIEF_CONFLICT: { status: 409, error: "Cette demande correspond à un autre contenu. Vérifie la mission avant de réessayer." },
  BRIEF_NOT_FOUND: { status: 404, error: "Cette mission est introuvable." },
  BRIEF_INVALID: { status: 400, error: "La demande de mission est invalide." },
  BRIEF_UNAVAILABLE: { status: 503, error: "Le service de missions est temporairement indisponible." },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

class BodyLimitError extends Error {}

/** Count transport bytes before JSON parsing, including chunked requests. */
async function readBoundedJson(message: Request | Response, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
  const length = message.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new BodyLimitError();
  if (!message.body) throw new Error("Missing body");
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new Error("Request cancelled");
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxBytes) { cancel(); throw new BodyLimitError(); }
      chunks.push(result.value);
    }
    if (signal?.aborted) throw new Error("Request cancelled");
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
function isoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}
function executionKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    // eslint-disable-next-line no-control-regex -- Execution references must reject control bytes before public projection.
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Project only public metadata; raw brief, user ID and provider traces never pass through. */
function publicMission(value: unknown, agentType: string, submissionId?: string) {
  if (!record(value) || !identifier(value.submissionId) || value.agentType !== agentType
    || (submissionId !== undefined && value.submissionId.toLowerCase() !== submissionId)
    || typeof value.state !== "string" || !missionStates.has(value.state)
    || !isoTimestamp(value.createdAt) || !isoTimestamp(value.updatedAt)
    || !Number.isInteger(value.attemptCount) || (value.attemptCount as number) < 0 || (value.attemptCount as number) > 3) {
    throw new Error("Invalid mission metadata");
  }
  let run = null;
  if (value.run !== null) {
    const candidate = value.run;
    if (!record(candidate) || !identifier(candidate.id)
      || typeof candidate.status !== "string" || !runStates.has(candidate.status)
      || (candidate.mode !== "live" && candidate.mode !== "simulation") || typeof candidate.mock !== "boolean") {
      throw new Error("Invalid run metadata");
    }
    run = { id: candidate.id.toLowerCase(), status: candidate.status, mode: candidate.mode, mock: candidate.mock };
  }
  return {
    submissionId: value.submissionId.toLowerCase(), agentType,
    state: value.state, createdAt: value.createdAt, updatedAt: value.updatedAt,
    attemptCount: value.attemptCount as number, run,
  };
}
function publicResult(value: unknown, input: ReturnType<typeof KartaTriggerSchema.parse>) {
  if (!record(value) || value.ok !== true) throw new Error("Invalid acceptance receipt");
  if (!("action" in input)) {
    if (value.queued !== true || (value.executionKey !== undefined && !executionKey(value.executionKey))
      || (value.jobId !== undefined && !executionKey(value.jobId))) throw new Error("Invalid queue receipt");
    return { ok: true, queued: true,
      ...(value.jobId !== undefined ? { jobId: value.jobId } : {}),
      ...(value.executionKey !== undefined ? { executionKey: value.executionKey } : {}),
    };
  }
  if (input.action === "list-briefs") {
    if (!Array.isArray(value.missions) || value.missions.length > 20) throw new Error("Invalid mission list");
    const missions = value.missions.map(row => publicMission(row, input.agentType));
    if (new Set(missions.map(row => row.submissionId)).size !== missions.length) throw new Error("Duplicate mission identity");
    return { ok: true, missions };
  }
  if (input.action === "brief-status") {
    return { ok: true, mission: value.mission === null ? null : publicMission(value.mission, input.agentType, input.submissionId) };
  }
  if (value.accepted !== true || !record(value.dispatch)
    || typeof value.dispatch.state !== "string" || !["queued", "unconfirmed", "not_requested"].includes(value.dispatch.state)
    || (value.dispatch.executionKey !== undefined && !executionKey(value.dispatch.executionKey))) throw new Error("Invalid mission acceptance");
  return { ok: true, accepted: true,
    mission: publicMission(value.mission, input.agentType, input.submissionId),
    dispatch: { state: value.dispatch.state,
      ...(value.dispatch.executionKey !== undefined ? { executionKey: value.dispatch.executionKey } : {}) },
  };
}

/** Authenticated proxy. The admin token and the account identity remain server-owned. */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);
  if (req.signal.aborted) return json({ error: "Demande annulée" }, 499);
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !/^Bearer [^\s]+$/i.test(authHeader)) return json({ error: "Non autorisé" }, 401);
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !supabaseKey) {
      console.error("karta-trigger: authentication configuration unavailable");
      return json({ error: "Service employés IA temporairement indisponible" }, 503);
    }
    const client = createClient(supabaseUrl, supabaseKey,
      { db: { schema: "purama_ai" }, global: { headers: { Authorization: authHeader } } });
    const { data, error: authError } = await client.auth.getUser(authHeader.slice(7));
    if (authError || !data?.user || !identifier(data.user.id)) return json({ error: "Non autorisé" }, 401);
    const userId = data.user.id.toLowerCase();
    if (req.signal.aborted) return json({ error: "Demande annulée" }, 499);
    let body: unknown;
    try { body = await readBoundedJson(req, MAX_BODY_BYTES, req.signal); }
    catch (error) {
      if (req.signal.aborted) return json({ error: "Demande annulée" }, 499);
      return json({ error: error instanceof BodyLimitError ? "Requête trop volumineuse" : "Demande invalide" },
        error instanceof BodyLimitError ? 413 : 400);
    }
    const parsed = KartaTriggerSchema.safeParse(body);
    if (!parsed.success) return json({ error: "Demande invalide", code: "BRIEF_INVALID" }, 400);
    const input = parsed.data;
    const read = "action" in input && (input.action === "list-briefs" || input.action === "brief-status");
    // Polling cannot consume the ten manual actions/hour. Both paths remain bounded.
    const limit = read ? rateLimit(`karta-trigger-read:${userId}`, 120, 60_000) : rateLimit(`karta-trigger:${userId}`, 10, 3_600_000);
    if (!limit.allowed) return json({ error: read ? "Trop de consultations. Réessaie dans un moment." : "Trop de déclenchements. Réessaie dans un moment." }, 429);
    const kartaUrl = Deno.env.get("KARTA_INTERNAL_URL");
    const kartaToken = Deno.env.get("KARTA_ADMIN_TOKEN");
    if (!kartaUrl || !kartaToken) {
      console.error("karta-trigger: internal configuration unavailable");
      return json({ error: "Service employés IA temporairement indisponible" }, 503);
    }
    let target: URL;
    try {
      target = new URL(kartaUrl);
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error();
      target.pathname = `${target.pathname.replace(/\/+$/, "")}/${read ? "briefs" : "trigger"}/${input.agentType}/${userId}`;
      if ("action" in input && input.action === "brief-status") target.searchParams.set("submissionId", input.submissionId);
    } catch {
      console.error("karta-trigger: internal configuration invalid");
      return json({ error: "Service employés IA temporairement indisponible" }, 503);
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${kartaToken}` };
    let internalBody: string | undefined;
    if (!read) {
      headers["Content-Type"] = "application/json";
      if ("requestId" in input && input.requestId) headers["Idempotency-Key"] = input.requestId;
      if ("action" in input && input.action === "submit-brief") {
        internalBody = JSON.stringify({ action: input.action, submissionId: input.submissionId, brief: input.brief });
      } else if ("action" in input && input.action === "retry-brief") {
        internalBody = JSON.stringify({ action: input.action, submissionId: input.submissionId });
      }
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    req.signal.addEventListener("abort", cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 10_000);
    try {
      if (req.signal.aborted) return json({ error: "Demande annulée" }, 499);
      const response = await fetch(target.toString(), {
        method: read ? "GET" : "POST", headers, body: internalBody, redirect: "error", signal: controller.signal,
      });
      const result = await readBoundedJson(response, MAX_RESPONSE_BYTES, controller.signal);
      if (!response.ok) {
        const known = record(result) && typeof result.code === "string" && Object.hasOwn(publicErrors, result.code)
          ? publicErrors[result.code] : undefined;
        if (known && known.status === response.status) return json({ error: known.error, code: (result as Record<string, unknown>).code }, known.status);
        console.error("karta-trigger: internal request rejected");
        return json({ error: "Résultat non confirmé. Consulte l’activité avant de réessayer." }, 502);
      }
      return json(publicResult(result, input), response.status === 202 ? 202 : 200);
    } catch {
      if (req.signal.aborted) return json({ error: "Demande annulée" }, 499);
      if (timedOut) return json({ error: "Délai dépassé. Consulte l’état de la mission avant de réessayer." }, 504);
      console.error("karta-trigger: internal response unavailable or invalid");
      return json({ error: "Résultat non confirmé. Consulte l’activité avant de réessayer." }, 502);
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener("abort", cancel);
    }
  } catch {
    console.error("karta-trigger: request unavailable");
    return json({ error: "Service employés IA temporairement indisponible" }, 503);
  }
});
