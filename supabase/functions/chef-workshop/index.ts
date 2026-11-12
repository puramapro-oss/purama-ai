import { createClient } from "npm:@supabase/supabase-js@2.91.0";
import { rateLimit } from "../_shared/rate-limit.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[a-z0-9-]{1,48}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const missionStates = new Set([
  "planning", "active", "paused", "human_required", "external_required",
  "verified_done", "failed", "cancelling", "cancelled",
]);
const taskStates = new Set([
  "pending", "ready", "claimed", "running", "verifying", "retryable",
  "blocked_human", "blocked_external", "verified_done", "failed", "cancelled",
]);
type WorkshopInput =
  | { action: "list" }
  | { action: "status" | "cancel"; missionId: string }
  | { action: "start"; projectId: string; requestId: string; prompt: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
function errorResponse(status: number, error: string, code: string): Response {
  return json({ ok: false, error, code }, status);
}
class BodyLimitError extends Error {}

/** Limit transport bytes, not string characters or the untrusted Content-Length. */
async function readBoundedJson(message: Request | Response, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
  const declaredLength = message.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    void message.body?.cancel().catch(() => undefined);
    throw new BodyLimitError();
  }
  if (!message.body) throw new Error("Missing body");
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new Error("Cancelled");
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) { cancel(); throw new BodyLimitError(); }
      chunks.push(part.value);
    }
    if (signal?.aborted) throw new Error("Cancelled");
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
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    // eslint-disable-next-line no-control-regex -- Reject control characters in public display metadata.
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
function count(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function parseInput(value: unknown): WorkshopInput | null {
  if (!record(value)) return null;
  if (value.action === "list" && exactKeys(value, ["action"])) return { action: "list" };
  if ((value.action === "status" || value.action === "cancel")
    && exactKeys(value, ["action", "missionId"]) && identifier(value.missionId)) {
    return { action: value.action, missionId: value.missionId.toLowerCase() };
  }
  if (value.action === "start" && exactKeys(value, ["action", "projectId", "requestId", "prompt"])
    && typeof value.projectId === "string" && PROJECT.test(value.projectId) && identifier(value.requestId)
    && typeof value.prompt === "string" && value.prompt.length <= 6000) {
    const prompt = value.prompt.trim();
    if (prompt.length >= 20 && !prompt.includes("\u0000")) {
      return { action: "start", projectId: value.projectId, requestId: value.requestId.toLowerCase(), prompt };
    }
  }
  return null;
}

function publicProject(value: unknown) {
  if (!record(value) || typeof value.id !== "string" || !PROJECT.test(value.id)
    || !text(value.name, 160) || typeof value.ready !== "boolean" || !count(value.maxParallel, 64)
    || value.maxParallel < 1) throw new Error("Invalid project");
  // Readiness text is generated here; server paths and provider exceptions never pass through.
  return {
    id: value.id, name: value.name, ready: value.ready, maxParallel: value.maxParallel,
    ...(!value.ready ? { unavailableReason: "Aucun exécuteur prêt pour ce projet. Consulte son état avant de lancer une mission." } : {}),
  };
}
function publicTask(value: unknown) {
  if (!record(value) || !identifier(value.id) || !text(value.key, 200) || !text(value.title, 512)
    || typeof value.state !== "string" || !taskStates.has(value.state)
    || (value.provider !== null && !["auto", "codex", "claude", "glm"].includes(String(value.provider)))
    || !count(value.attempt, 20) || !count(value.evidenceCount, 1_000_000)
    || (value.outputSha !== null && (typeof value.outputSha !== "string" || !SHA.test(value.outputSha)))) {
    throw new Error("Invalid task");
  }
  return {
    id: value.id.toLowerCase(), key: value.key, title: value.title, state: value.state,
    provider: value.provider as string | null, attempt: value.attempt, evidenceCount: value.evidenceCount,
    outputSha: value.state === "verified_done" && typeof value.outputSha === "string" ? value.outputSha.toLowerCase() : null,
  };
}
function publicMission(value: unknown) {
  if (!record(value) || !identifier(value.id) || typeof value.projectId !== "string" || !PROJECT.test(value.projectId)
    || !text(value.title, 512) || typeof value.state !== "string" || !missionStates.has(value.state)
    || !timestamp(value.createdAt) || !timestamp(value.updatedAt)
    || (value.finishedAt !== null && !timestamp(value.finishedAt))
    || !count(value.totalTasks, 256) || !count(value.verifiedTasks, value.totalTasks)
    || !record(value.usage) || !count(value.usage.tokens) || !count(value.usage.costMicros)) {
    throw new Error("Invalid mission");
  }
  return {
    id: value.id.toLowerCase(), projectId: value.projectId, title: value.title, state: value.state,
    createdAt: value.createdAt, updatedAt: value.updatedAt, finishedAt: value.finishedAt as string | null,
    verifiedTasks: value.verifiedTasks, totalTasks: value.totalTasks,
    usage: { tokens: value.usage.tokens, costMicros: value.usage.costMicros },
  };
}
function publicResult(value: unknown, input: WorkshopInput) {
  if (!record(value) || value.ok !== true) throw new Error("Invalid result");
  if (input.action === "list") {
    if (!Array.isArray(value.projects) || value.projects.length > 64
      || !Array.isArray(value.missions) || value.missions.length > 50) throw new Error("Invalid list");
    const projects = value.projects.map(publicProject);
    const missions = value.missions.map(publicMission);
    if (new Set(projects.map(project => project.id)).size !== projects.length
      || new Set(missions.map(mission => mission.id)).size !== missions.length) throw new Error("Duplicate identity");
    return { ok: true, projects, missions };
  }
  const mission = publicMission(value.mission);
  if ((input.action === "start" && mission.projectId !== input.projectId)
    || (input.action !== "start" && mission.id !== input.missionId)
    || !record(value.mission) || !Array.isArray(value.mission.tasks)
    || value.mission.tasks.length !== mission.totalTasks) throw new Error("Mismatched mission");
  const tasks = value.mission.tasks.map(publicTask);
  if (new Set(tasks.map(task => task.id)).size !== tasks.length
    || new Set(tasks.map(task => task.key)).size !== tasks.length
    || tasks.filter(task => task.state === "verified_done").length !== mission.verifiedTasks) throw new Error("Invalid task counts");
  let previewUrl: string | undefined;
  if (mission.state === "verified_done" && value.mission.previewUrl !== undefined) {
    if (typeof value.mission.previewUrl !== "string" || value.mission.previewUrl.length > 2048) throw new Error("Invalid preview");
    const url = new URL(value.mission.previewUrl);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid preview");
    previewUrl = url.href;
  }
  return { ok: true, mission: { ...mission, tasks, ...(previewUrl ? { previewUrl } : {}) } };
}
function upstreamFailure(status: number): Response {
  const known: Record<number, [string, string]> = {
    400: ["Demande invalide.", "WORKSHOP_INVALID"],
    401: ["Le service de création est temporairement indisponible.", "WORKSHOP_UNAVAILABLE"],
    403: ["Ce projet n’est pas accessible avec ce compte.", "WORKSHOP_FORBIDDEN"],
    404: ["Cette mission ou ce projet est introuvable.", "WORKSHOP_NOT_FOUND"],
    409: ["La demande entre en conflit avec une mission existante. Consulte son état avant de réessayer.", "WORKSHOP_CONFLICT"],
    413: ["Requête trop volumineuse.", "WORKSHOP_INVALID"],
    429: ["Trop de demandes. Réessaie dans un moment.", "WORKSHOP_RATE_LIMITED"],
    503: ["Aucun exécuteur disponible. Consulte l’état du projet avant de réessayer.", "WORKSHOP_UNAVAILABLE"],
  };
  const safe = known[status];
  return safe ? errorResponse(status, safe[0], safe[1])
    : errorResponse(502, "Résultat non confirmé. Consulte l’état de la mission avant de réessayer.", "WORKSHOP_UNCONFIRMED");
}

/** All actions use the verified account identity; internal credentials stay on the server. */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Méthode non autorisée.", "WORKSHOP_METHOD");
  if (req.signal.aborted) return errorResponse(499, "Demande annulée.", "WORKSHOP_CANCELLED");
  try {
    const authorization = req.headers.get("Authorization");
    if (!authorization || !/^Bearer [^\s]+$/i.test(authorization)) return errorResponse(401, "Non autorisé.", "WORKSHOP_AUTH");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !anonKey) return errorResponse(503, "Service temporairement indisponible.", "WORKSHOP_UNAVAILABLE");
    const client = createClient(supabaseUrl, anonKey, {
      db: { schema: "purama_ai" }, global: { headers: { Authorization: authorization } },
    });
    const { data, error: authError } = await client.auth.getUser(authorization.slice(7));
    if (authError || !data?.user || !identifier(data.user.id)) return errorResponse(401, "Non autorisé.", "WORKSHOP_AUTH");
    const userId = data.user.id.toLowerCase();
    if (req.signal.aborted) return errorResponse(499, "Demande annulée.", "WORKSHOP_CANCELLED");
    let body: unknown;
    try { body = await readBoundedJson(req, MAX_REQUEST_BYTES, req.signal); }
    catch (error) {
      if (req.signal.aborted) return errorResponse(499, "Demande annulée.", "WORKSHOP_CANCELLED");
      return error instanceof BodyLimitError
        ? errorResponse(413, "Requête trop volumineuse.", "WORKSHOP_INVALID")
        : errorResponse(400, "Demande invalide.", "WORKSHOP_INVALID");
    }
    const input = parseInput(body);
    if (!input) return errorResponse(400, "Demande invalide.", "WORKSHOP_INVALID");
    const bucket = input.action === "start" ? "start" : input.action === "cancel" ? "cancel" : "read";
    const limit = rateLimit("chef-workshop:" + bucket + ":" + userId, bucket === "start" ? 10 : 120,
      bucket === "start" ? 3_600_000 : 60_000);
    if (!limit.allowed) return errorResponse(429, "Trop de demandes. Réessaie dans un moment.", "WORKSHOP_RATE_LIMITED");
    const internalUrl = Deno.env.get("KARTA_INTERNAL_URL");
    const adminToken = Deno.env.get("KARTA_ADMIN_TOKEN");
    if (!internalUrl || !adminToken) return errorResponse(503, "Service temporairement indisponible.", "WORKSHOP_UNAVAILABLE");
    let target: URL;
    try {
      target = new URL(internalUrl);
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error();
      target.pathname = target.pathname.replace(/\/+$/, "") + "/workshop/" + userId;
    } catch { return errorResponse(503, "Service temporairement indisponible.", "WORKSHOP_UNAVAILABLE"); }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    req.signal.addEventListener("abort", cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 10_000);
    try {
      if (req.signal.aborted) return errorResponse(499, "Demande annulée.", "WORKSHOP_CANCELLED");
      const response = await fetch(target.href, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { Authorization: "Bearer " + adminToken, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        // No upstream error text is needed to render a safe message.
        void response.body?.cancel().catch(() => undefined);
        return upstreamFailure(response.status);
      }
      const result = await readBoundedJson(response, MAX_RESPONSE_BYTES, controller.signal);
      return json(publicResult(result, input), response.status === 202 ? 202 : 200);
    } catch {
      if (req.signal.aborted) return errorResponse(499, "Demande annulée.", "WORKSHOP_CANCELLED");
      if (timedOut) return errorResponse(504, "Délai dépassé. Consulte l’état de la mission avant de réessayer.", "WORKSHOP_UNCONFIRMED");
      return upstreamFailure(502);
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener("abort", cancel);
    }
  } catch {
    return errorResponse(503, "Service temporairement indisponible.", "WORKSHOP_UNAVAILABLE");
  }
});
