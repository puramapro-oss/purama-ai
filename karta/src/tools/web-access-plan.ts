import type { ToolDefinition } from "../engine/types.js";
import {
  isWebAccessUserId, parseWebAccessIntent, planWebCapabilityAccess, webAccessPlanResult,
  type WebAccessIntent, type WebAccessPlan,
} from "../lib/web-capability-plan.js";

export interface WebAccessContextRequest extends WebAccessIntent {
  /** Comes only from the authenticated KARTA execution context. */
  userId: string;
}

export type ResolveTrustedWebAccessContext = (
  request: Readonly<WebAccessContextRequest>,
  signal: AbortSignal,
) => unknown | Promise<unknown>;

export const WEB_CONTEXT_RESOLUTION_TIMEOUT_MS = 5_000;

/**
 * Factory only: callers must supply a trusted, tenant-scoped server resolver.
 * No default resolver, global registration, credential acquisition or browser is
 * installed here. The resolver must load canonical permission/operation facts;
 * it must not create resources, reserve money or execute the requested action.
 * It must honor AbortSignal to stop its own I/O. The deadline returns a blocked
 * plan even if an injected resolver ignores cancellation; it cannot kill that I/O.
 */
export function createWebAccessPlanTool(
  resolveTrustedContext: ResolveTrustedWebAccessContext,
  now: () => number = Date.now,
): ToolDefinition<WebAccessIntent, WebAccessPlan> {
  if (typeof resolveTrustedContext !== "function" || typeof now !== "function") {
    throw new Error("Résolveur et horloge web requis");
  }
  return {
    name: "plan_web_access",
    description: "Prépare uniquement un chemin d'accès web à partir des permissions serveur. N'exécute aucune action, ne connecte aucun compte, ne crée aucune clé et ne réserve aucun budget.",
    sensitive: false,
    inputSchema: {
      type: "object",
      properties: {
        serviceId: { type: "string", minLength: 1, maxLength: 200 },
        action: { type: "string", enum: ["read", "write", "create_account", "create_api_key"] },
        operationId: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["serviceId", "action", "operationId"],
      additionalProperties: false,
    },
    async execute(params, ctx) {
      const intent = parseWebAccessIntent(params);
      const userId = ctx.userId;
      if (!isWebAccessUserId(userId)) throw new Error("Utilisateur web invalide");
      const request = Object.freeze({
        userId, serviceId: intent.serviceId, action: intent.action, operationId: intent.operationId,
      });
      let trusted: unknown;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Web context resolution deadline"));
          }, WEB_CONTEXT_RESOLUTION_TIMEOUT_MS);
        });
        trusted = await Promise.race([
          Promise.resolve().then(() => resolveTrustedContext(request, controller.signal)),
          deadline,
        ]);
      }
      catch {
        // Resolver errors can contain credentials or personal data: never echo them.
        return webAccessPlanResult("blocked_external", "resolver_unavailable");
      }
      finally { clearTimeout(timer); }
      // Read the clock AFTER resolution: the snapshot may have expired while loading.
      try { return planWebCapabilityAccess(intent, userId, trusted, now()); }
      catch {
        // A malformed server object/getter or clock must not leak an exception
        // containing secret data through KARTA's generic error summaries.
        return webAccessPlanResult("blocked_external", "context_invalid");
      }
    },
  };
}
