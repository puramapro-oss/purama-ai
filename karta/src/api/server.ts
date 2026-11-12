import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { supabase } from "../db/supabase.js";
import { setGlobalKillSwitch } from "../engine/killswitch.js";
import type { RuntimeReadiness } from "../runtime/lifecycle.js";
import { enqueueAgentCycle } from "../queue/queues.js";
import { CycleDeliveryConflictError, getQueuedExecutionKey } from "../queue/delivery-identity.js";
import { AGENT_REGISTRY } from "../agents/index.js";
import { loadCustomAgent } from "../agents/customAgent.js";
import { resolvePendingAction } from "../engine/approval.js";
import { BriefSubmissionError, dispatchBrief, getBriefStatus, listBriefs, submitBrief } from "../engine/brief-submission.js";
import { handleWorkshopRequest, WorkshopError } from "../chef/workshop-service.js";
import type { StaticAgentType } from "../engine/types.js";

const VALID_AGENT_TYPES = Object.keys(AGENT_REGISTRY) as StaticAgentType[];

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 65_536) throw new RequestError(413, "Requête trop volumineuse");
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new RequestError(400, "Objet JSON invalide"); }
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function readActive(body: Record<string, unknown>): boolean {
  if (typeof body.active !== "boolean") throw new RequestError(400, "active doit être un booléen");
  return body.active;
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!config.adminToken) return false; // pas de token configuré = aucun accès mutant (fail-closed)
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(req.headers.authorization ?? ""), digest(`Bearer ${config.adminToken}`));
}

function readIdempotencyKey(req: IncomingMessage): string | undefined {
  const raw = req.headers["idempotency-key"];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^[A-Za-z0-9._~-]{8,128}$/.test(raw)) {
    throw new RequestError(400, "Idempotency-Key invalide");
  }
  return raw;
}

/** API interne KARTA : health check public, endpoints mutants (kill switch, trigger manuel) protégés par bearer token. */
export function startApiServer(readiness?: () => Promise<RuntimeReadiness>) {
  const server = createServer((req, res) => {
    void handleRequest(req, res, readiness).catch((error) => {
      if (res.destroyed || res.headersSent) return;
      if (error instanceof RequestError) json(res, error.status, { error: error.message });
      else if (error instanceof WorkshopError) json(res, error.status, { ok: false, code: error.code, error: error.message });
      else if (error instanceof BriefSubmissionError) json(res, error.status, { error: error.message, code: error.code });
      else if (error instanceof CycleDeliveryConflictError) json(res, 409, { error: error.message });
      else { console.error("[api] requête échouée"); json(res, 500, { error: "Erreur interne" }); }
    });
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.setTimeout(15_000, socket => socket.destroy());
  server.listen(config.port, () => console.log(`[api] KARTA écoute sur :${config.port}`));
  return server;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse,
  readiness?: () => Promise<RuntimeReadiness>): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

  if (req.method === "GET" && url.pathname === "/live") {
    json(res, 200, { status: "alive" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    const state = await readiness?.().catch(() => ({ ready: false, phase: "failed" as const }))
      ?? { ready: false, phase: "starting" as const };
    json(res, state.ready ? 200 : 503, {
      status: state.ready ? "ok" : "unavailable",
      ...state,
      mockClaude: config.mockClaude,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (!isAuthorized(req)) {
    json(res, 401, { error: "Non autorisé (KARTA_ADMIN_TOKEN manquant ou invalide)" });
    return;
  }

  const requireReady = async (): Promise<boolean> => {
    if (readiness && !(await readiness().catch(() => ({ ready: false }))).ready) {
      json(res, 503, { error: "KARTA temporairement indisponible" });
      return false;
    }
    return true;
  };

  if (req.method === "POST" && url.pathname === "/kill-switch/global") {
    const body = await readBody(req);
    const active = readActive(body);
    // Emergency stops remain available when Redis or the relay is down.
    if (!active && !await requireReady()) return;
    await setGlobalKillSwitch(active);
    json(res, 200, { ok: true, active });
    return;
  }

  const agentStateMatch = url.pathname.match(/^\/kill-switch\/([a-z-]+)\/([0-9a-f-]+)$/);
  if (req.method === "POST" && agentStateMatch) {
    const [, agentType, userId] = agentStateMatch;
    if (!VALID_AGENT_TYPES.includes(agentType as StaticAgentType)) {
      json(res, 400, { error: `Agent inconnu: ${agentType}` });
      return;
    }
    const body = await readBody(req);
    const active = readActive(body);
    if (!active && !await requireReady()) return;
    const { error } = await supabase
      .from("karta_agent_state")
      .update({ kill_switch: active, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("agent_type", agentType);
    if (error) {
      json(res, 500, { error: "Modification indisponible" });
      return;
    }
    json(res, 200, { ok: true });
    return;
  }

  // Authenticated proxy supplies the owner in the path. Cancel/status remain
  // available during degraded queue readiness; no browser can send the admin key.
  const workshopMatch = url.pathname.match(/^\/workshop\/([0-9a-f-]{36})$/i);
  if (req.method === "POST" && workshopMatch) {
    if (url.search) throw new RequestError(400, "Paramètres atelier invalides");
    const body = await readBody(req);
    if (body.action === "start" && !await requireReady()) return;
    res.setHeader("Cache-Control", "no-store");
    json(res, 200, await handleWorkshopRequest(workshopMatch[1]!, body));
    return;
  }

  if (!await requireReady()) return;

  const briefsMatch = url.pathname.match(/^\/briefs\/([a-z-]+)\/([0-9a-f-]+)$/);
  if (req.method === "GET" && briefsMatch) {
    const [, agentType, userId] = briefsMatch;
    if ([...url.searchParams.keys()].some(key => key !== "submissionId") || url.searchParams.getAll("submissionId").length > 1) {
      throw new BriefSubmissionError("BRIEF_INVALID");
    }
    const id = url.searchParams.get("submissionId");
    json(res, 200, id === null
      ? { ok: true, missions: await listBriefs({ userId, agentType }) }
      : { ok: true, mission: await getBriefStatus({ userId, agentType }, id) });
    return;
  }

  const triggerMatch = url.pathname.match(/^\/trigger\/([a-z-]+)\/([0-9a-f-]+)$/);
  if (req.method === "POST" && triggerMatch) {
    const [, agentType, userId] = triggerMatch;
    if (!VALID_AGENT_TYPES.includes(agentType as StaticAgentType)) {
      json(res, 400, { error: `Agent inconnu: ${agentType}` });
      return;
    }
    const requestKey = readIdempotencyKey(req);
    const body = await readBody(req);
    if (body.action === "submit-brief" || body.action === "retry-brief") {
      const allowed = body.action === "submit-brief" ? ["action", "submissionId", "brief"] : ["action", "submissionId"];
      if (Object.keys(body).some(key => !allowed.includes(key)) || typeof body.submissionId !== "string"
        || !requestKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestKey)) {
        throw new BriefSubmissionError("BRIEF_INVALID");
      }
      const scope = { userId, agentType };
      const mission = body.action === "submit-brief"
        ? await submitBrief(scope, body.submissionId, body.brief)
        : await getBriefStatus(scope, body.submissionId);
      if (!mission) throw new BriefSubmissionError("BRIEF_NOT_FOUND");
      const dispatch = await dispatchBrief(scope, mission, requestKey);
      json(res, 202, { ok: true, accepted: true, mission, dispatch });
      return;
    }
    if (Object.keys(body).length !== 0) throw new RequestError(400, "Contrat de déclenchement invalide");
    const jobId = await enqueueAgentCycle(
      {
        agentType: agentType as StaticAgentType,
        userId,
        trigger: { type: "manual", source: "api", payload: requestKey ? { requestKey } : undefined },
      },
      requestKey ? { dedupeKey: `manual|${agentType}|${userId}|${requestKey}` } : undefined
    );
    json(res, 202, { ok: true, queued: true, jobId, executionKey: getQueuedExecutionKey(jobId) });
    return;
  }

  const triggerCustomMatch = url.pathname.match(/^\/trigger-custom\/([0-9a-f-]+)$/);
  if (req.method === "POST" && triggerCustomMatch) {
    const [, agentId] = triggerCustomMatch;
    const row = await loadCustomAgent(agentId);
    if (!row) {
      json(res, 404, { error: "Agent introuvable" });
      return;
    }
    if (!row.karta_enabled) {
      json(res, 400, { error: "Cet agent n'est pas activé en mode exécution réelle (KARTA)" });
      return;
    }
    const requestKey = readIdempotencyKey(req);
    const jobId = await enqueueAgentCycle(
      {
        agentType: `custom:${row.id}`,
        userId: row.user_id,
        trigger: { type: "manual", source: "api", payload: requestKey ? { requestKey } : undefined },
      },
      requestKey ? { dedupeKey: `manual|custom:${row.id}|${row.user_id}|${requestKey}` } : undefined
    );
    json(res, 202, { ok: true, queued: true, jobId, executionKey: getQueuedExecutionKey(jobId) });
    return;
  }

  const pendingActionMatch = url.pathname.match(/^\/pending-actions\/([0-9a-f-]+)\/(approve|reject)$/);
  if (req.method === "POST" && pendingActionMatch) {
    const [, id, decision] = pendingActionMatch;
    const result = await resolvePendingAction(id, decision as "approve" | "reject");
    if (!result.ok) {
      json(res, 400, { error: result.error });
      return;
    }
    json(res, 200, { ok: true, resultSummary: result.resultSummary });
    return;
  }

  json(res, 404, { error: "Route inconnue" });
}
