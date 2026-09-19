import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { supabase } from "../db/supabase.js";
import { setGlobalKillSwitch, isGlobalKillSwitchActive } from "../engine/killswitch.js";
import { enqueueAgentCycle } from "../queue/queues.js";
import { AGENT_REGISTRY } from "../agents/index.js";
import { loadCustomAgent } from "../agents/customAgent.js";
import { resolvePendingAction } from "../engine/approval.js";
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

/** API interne KARTA : health check public, endpoints mutants (kill switch, trigger manuel) protégés par bearer token. */
export function startApiServer() {
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      if (res.destroyed || res.headersSent) return;
      if (error instanceof RequestError) json(res, error.status, { error: error.message });
      else { console.error("[api] requête échouée"); json(res, 500, { error: "Erreur interne" }); }
    });
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.setTimeout(15_000, socket => socket.destroy());
  server.listen(config.port, () => console.log(`[api] KARTA écoute sur :${config.port}`));
  return server;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

  if (req.method === "GET" && url.pathname === "/health") {
    const globalKillSwitch = await isGlobalKillSwitchActive();
    json(res, 200, {
      status: "ok",
      mockClaude: config.mockClaude,
      globalKillSwitch,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (!isAuthorized(req)) {
    json(res, 401, { error: "Non autorisé (KARTA_ADMIN_TOKEN manquant ou invalide)" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/kill-switch/global") {
    const body = await readBody(req);
    const active = readActive(body);
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
    const { error } = await supabase
      .from("karta_agent_state")
      .update({ kill_switch: readActive(body), updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("agent_type", agentType);
    if (error) {
      json(res, 500, { error: "Modification indisponible" });
      return;
    }
    json(res, 200, { ok: true });
    return;
  }

  const triggerMatch = url.pathname.match(/^\/trigger\/([a-z-]+)\/([0-9a-f-]+)$/);
  if (req.method === "POST" && triggerMatch) {
    const [, agentType, userId] = triggerMatch;
    if (!VALID_AGENT_TYPES.includes(agentType as StaticAgentType)) {
      json(res, 400, { error: `Agent inconnu: ${agentType}` });
      return;
    }
    await enqueueAgentCycle({
      agentType: agentType as StaticAgentType,
      userId,
      trigger: { type: "manual", source: "api" },
    });
    json(res, 202, { ok: true, queued: true });
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
    await enqueueAgentCycle({
      agentType: `custom:${row.id}`,
      userId: row.user_id,
      trigger: { type: "manual", source: "api" },
    });
    json(res, 202, { ok: true, queued: true });
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
