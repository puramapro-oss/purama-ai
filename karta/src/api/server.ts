import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "../config.js";
import { supabase } from "../db/supabase.js";
import { setGlobalKillSwitch, isGlobalKillSwitchActive } from "../engine/killswitch.js";
import { enqueueAgentCycle } from "../queue/queues.js";
import { AGENT_REGISTRY } from "../agents/index.js";
import type { AgentType } from "../engine/types.js";

const VALID_AGENT_TYPES = Object.keys(AGENT_REGISTRY) as AgentType[];

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
export function startApiServer() {
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      console.error("[api] erreur non gérée:", error);
      json(res, 500, { error: error instanceof Error ? error.message : "erreur interne" });
    });
  });

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
    await setGlobalKillSwitch(Boolean(body.active));
    json(res, 200, { ok: true, active: Boolean(body.active) });
    return;
  }

  const agentStateMatch = url.pathname.match(/^\/kill-switch\/([a-z]+)\/([0-9a-f-]+)$/);
  if (req.method === "POST" && agentStateMatch) {
    const [, agentType, userId] = agentStateMatch;
    if (!VALID_AGENT_TYPES.includes(agentType as AgentType)) {
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

  const triggerMatch = url.pathname.match(/^\/trigger\/([a-z]+)\/([0-9a-f-]+)$/);
  if (req.method === "POST" && triggerMatch) {
    const [, agentType, userId] = triggerMatch;
    if (!VALID_AGENT_TYPES.includes(agentType as AgentType)) {
      json(res, 400, { error: `Agent inconnu: ${agentType}` });
      return;
    }
    await enqueueAgentCycle({
      agentType: agentType as AgentType,
      userId,
      trigger: { type: "manual", source: "api" },
    });
    json(res, 202, { ok: true, queued: true });
    return;
  }

  json(res, 404, { error: "Route inconnue" });
}
