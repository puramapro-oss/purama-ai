import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "../config.js";
import { supabase } from "../db/supabase.js";
import { setGlobalKillSwitch } from "../engine/killswitch.js";
import { enqueueAgentCycle } from "../queue/queues.js";
import { AGENT_REGISTRY } from "../agents/index.js";
import { loadCustomAgent } from "../agents/customAgent.js";
import { resolvePendingAction } from "../engine/approval.js";
import type { StaticAgentType } from "../engine/types.js";
import type { KartaRuntime } from "../runtime.js";

const VALID_AGENT_TYPES = Object.keys(AGENT_REGISTRY) as StaticAgentType[];

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!config.adminToken) return false; // pas de token configuré = aucun accès mutant (fail-closed)
  return req.headers.authorization === `Bearer ${config.adminToken}`;
}

/** API interne KARTA : health check public, endpoints mutants (kill switch, trigger manuel) protégés par bearer token. */
export function startApiServer(runtime: KartaRuntime) {
  const requests = new Set<Promise<void>>();
  let stopping = false;
  let closing: Promise<void> | undefined;
  const server = createServer((req, res) => {
    const request = handleRequest(req, res, runtime, stopping).catch((error: unknown) => {
      console.error("[api] erreur non gérée:", error);
      if (!res.headersSent && !res.destroyed) {
        json(res, 500, { error: error instanceof Error ? error.message : "erreur interne" });
      }
    });
    requests.add(request);
    void request.then(() => requests.delete(request));
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, () => {
      server.removeListener("error", reject);
      console.log(`[api] KARTA écoute sur :${config.port}`);
      resolve();
    });
  });
  void ready.catch(() => {}); // owned by runtime, avoid an early unhandled listen error
  // Keep errors observable without crashing outside the coordinated shutdown path.
  server.on("error", (error) => {
    console.error("[api] server error:", error);
    void runtime.stop(1);
  });
  const stop = (): void => {
    stopping = true;
    closing ??= ready.then(() => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }), () => {});
    void closing.catch(() => {});
  };
  return {
    server,
    ready,
    stop,
    async drain(): Promise<void> {
      stop();
      // Track the handler itself as well as the socket: disconnected clients may
      // leave approval/trigger side effects in flight after the HTTP close callback.
      await Promise.all([closing, ...requests]);
    },
  };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse,
  runtime: KartaRuntime, stopping: boolean): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

  if (req.method === "GET" && url.pathname === "/health") {
    const health = await runtime.health();
    const ready = health.ready && runtime.state === "ready";
    json(res, ready ? 200 : 503, {
      status: ready ? "ok" : "not_ready",
      mockClaude: config.mockClaude,
      globalKillSwitch: health.globalKillSwitch,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (stopping || runtime.state !== "ready") {
    json(res, 503, { error: "KARTA indisponible" });
    return;
  }

  if (!isAuthorized(req)) {
    json(res, 401, { error: "Non autorisé (KARTA_ADMIN_TOKEN manquant ou invalide)" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/kill-switch/global") {
    const body = await readBody(req);
    await setGlobalKillSwitch(Boolean(body.active));
    json(res, 200, { ok: true, active: Boolean(body.active) });
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
      .update({ kill_switch: Boolean(body.active), updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("agent_type", agentType);
    if (error) {
      json(res, 500, { error: error.message });
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
