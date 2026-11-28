import { createHash, randomBytes, randomUUID } from "node:crypto";
import { supabase } from "../db/supabase.js";
import { bounded } from "../runtime/lifecycle.js";
import { createConsultationHost } from "../claude/consultation-host.js";
import { createConsultationStore, type ConsultationRpcClient } from "../claude/consultation-store.js";
import type { ConsultationCatalog, ConsultationHost, ConsultationInput, ConsultationOperation } from "./consultation-contract.js";

export type PublicApiScope = "catalog" | "create" | "read" | "cancel";
export interface PublicApiGrant {
  keyId: string;
  projectId: string;
  userId: string;
  allowedModels: string[];
  /** Internal maximum estimated cost for one operation, not a customer price. */
  maxOperationCostMicros: number;
}
export interface PublicApiRuntime {
  /** Wait for admitted effects to persist their receipts after HTTP shutdown. */
  drain?(): Promise<void>;
  authenticate(key: string, scope: PublicApiScope, signal: AbortSignal): Promise<PublicApiGrant>;
  catalog(key: string, grant: PublicApiGrant, signal: AbortSignal): Promise<ConsultationCatalog>;
  operation(key: string, grant: PublicApiGrant, operationId: string,
    action: "consult" | "status" | "cancel", input: ConsultationInput | undefined,
    signal: AbortSignal): Promise<ConsultationOperation | null>;
}
export class PublicApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super("Demande API indisponible.");
    this.name = "PublicApiError";
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/i;
const KEY = /^iao_sk_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$(?![\s\S])/;
const SCOPES = new Set<PublicApiScope>(["catalog", "create", "read", "cancel"]);
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$(?![\s\S])/;
const invalid = () => new PublicApiError(400, "IAO_API_INVALID");
const unavailable = () => new PublicApiError(503, "IAO_API_UNAVAILABLE");
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Operator-side creation. Persist keyId/keyHash only; deliver key once through
 * the operator's secret channel. This function does not allocate any resources. */
export function generateIaoApiKey(): { keyId: string; key: string; keyHash: string } {
  const keyId = randomUUID();
  const key = `iao_sk_${keyId}.${randomBytes(32).toString("base64url")}`;
  return { keyId, key, keyHash: createHash("sha256").update(key).digest("hex") };
}
function digestKey(key: string): { id: string; hash: string } {
  const match = typeof key === "string" && KEY.exec(key);
  if (!match || Buffer.from(match[2]!, "base64url").toString("base64url") !== match[2]) {
    throw new PublicApiError(401, "IAO_API_UNAUTHORIZED");
  }
  return { id: match[1]!, hash: createHash("sha256").update(key).digest("hex") };
}
function sqlError(code: string | undefined): PublicApiError | undefined {
  switch (code) {
    case "PIA01": return new PublicApiError(401, "IAO_API_UNAUTHORIZED");
    case "PIA02": return new PublicApiError(403, "IAO_API_FORBIDDEN");
    case "PIA03": return new PublicApiError(429, "IAO_API_RATE_LIMIT");
    case "PIA04": return new PublicApiError(429, "IAO_API_LIMIT");
    case "PIA05": return invalid();
    default: return undefined;
  }
}
function projectGrant(value: unknown, keyId: string): PublicApiGrant {
  if (!record(value) || value.keyId !== keyId
    || Object.keys(value).some(k => !["keyId", "projectId", "userId", "allowedModels", "maxOperationCostMicros"].includes(k))
    || typeof value.projectId !== "string" || !UUID.test(value.projectId)
    || typeof value.userId !== "string" || !UUID.test(value.userId)
    || !Array.isArray(value.allowedModels) || value.allowedModels.length < 1 || value.allowedModels.length > 32
    || value.allowedModels.some(m => typeof m !== "string" || !MODEL.test(m))
    || new Set(value.allowedModels).size !== value.allowedModels.length
    || !Number.isSafeInteger(value.maxOperationCostMicros) || Number(value.maxOperationCostMicros) < 1) throw unavailable();
  return { keyId, projectId: value.projectId, userId: value.userId, allowedModels: [...value.allowedModels],
    maxOperationCostMicros: Number(value.maxOperationCostMicros) };
}

/** A public authority adapter around the existing Council, not another engine.
 * SQL rechecks the project/key while reserving each effect in the CHEF ledger.
 * In-flight settlement remains possible after revocation so cost uncertainty is
 * preserved. No public route can call those private settlement functions. */
export function createPublicApiRuntime(options: {
  client?: ConsultationRpcClient;
  createHost?: (store: ReturnType<typeof createConsultationStore>) => ConsultationHost;
} = {}): PublicApiRuntime {
  const client = options.client ?? supabase as unknown as ConsultationRpcClient;
  const hostFactory = options.createHost ?? (store => createConsultationHost({ store }));
  // Local cancellation accelerates the durable SQL cancellation. Across server
  // instances, the SQL guard prevents the next reservation; an already sent
  // provider call cannot be recalled by changing an API key.
  const active = new Map<string, Set<AbortController>>();
  const pendingOperations = new Set<Promise<ConsultationOperation | null>>();
  async function rpc(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    try {
      return await bounded(async current => {
        const result = await client.rpc(name, args).abortSignal(current);
        current.throwIfAborted();
        if (result.error) throw sqlError(result.error.code) ?? unavailable();
        return result.data;
      }, 5000, signal);
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      throw unavailable();
    }
  }
  function scopedHost(keyHash: string, grant: PublicApiGrant, externalId: string | null, internalId: string | null) {
    let authorityError: PublicApiError | undefined;
    const guarded = new Set(["availability", "status", "resume", "cancel", "create", "start", "reserve"]);
    const scopedClient: ConsultationRpcClient = {
      rpc(name, args) {
        return { async abortSignal(signal) {
          signal.throwIfAborted();
          const method = name.startsWith("model_consultation_") ? name.slice("model_consultation_".length) : "";
          if (args.p_user_id !== grant.userId || (method !== "availability" && (!internalId || args.p_operation_id !== internalId))) {
            authorityError = unavailable();
            return { data: null, error: { code: "PIA05" } };
          }
          // Explicit allowlist: a newly added RPC is closed until reviewed.
          if (guarded.has(method)) {
            const result = await client.rpc("iao_api_consultation_call", {
              p_key_hash: keyHash, p_operation_id: externalId, p_method: method, p_args: args,
            }).abortSignal(signal);
            if (result.error) authorityError = sqlError(result.error.code);
            return result;
          }
          if ((method === "settle" || method === "finalize") && internalId) {
            return client.rpc(name, args).abortSignal(signal);
          }
          authorityError = unavailable();
          return { data: null, error: { code: "PIA05" } };
        } };
      },
    };
    const host = hostFactory(createConsultationStore({ client: scopedClient }));
    return { host, check() { if (authorityError) throw authorityError; } };
  }
  return {
    async drain() {
      while (pendingOperations.size) await Promise.allSettled([...pendingOperations]);
    },
    async authenticate(key, scope, signal) {
      if (!SCOPES.has(scope)) throw invalid();
      const identity = digestKey(key);
      return projectGrant(await rpc("iao_api_authorize", {
        p_key_hash: identity.hash, p_scope: scope, p_consume_rate: true,
      }, signal), identity.id);
    },
    async catalog(key, rawGrant, signal) {
      const identity = digestKey(key);
      const grant = projectGrant(rawGrant, identity.id);
      const currentGrant = projectGrant(await rpc("iao_api_authorize", {
        p_key_hash: identity.hash, p_scope: "catalog", p_consume_rate: false,
      }, signal), identity.id);
      if (currentGrant.userId !== grant.userId || currentGrant.projectId !== grant.projectId) throw unavailable();
      const scoped = scopedHost(identity.hash, currentGrant, null, null);
      try {
        const catalog = await scoped.host.catalog(grant.userId, signal);
        scoped.check(); signal.throwIfAborted();
        const models = catalog.models.filter(model => currentGrant.allowedModels.includes(model.model));
        return models.length || !catalog.available ? { ...catalog, models }
          : { ...catalog, available: false, reason: "model_unavailable", models: [] };
      } catch (error) { scoped.check(); throw error; }
    },
    operation(key, rawGrant, operationId, action, input, signal) {
      const pending = (async () => {
        if (typeof operationId !== "string" || !UUID.test(operationId)
          || !["consult", "status", "cancel"].includes(action)) throw invalid();
        const identity = digestKey(key);
        const grant = projectGrant(rawGrant, identity.id);
        const scope: PublicApiScope = action === "consult" ? "create" : action === "status" ? "read" : "cancel";
        if (action === "consult" && (!input || input.operationId !== operationId)) throw invalid();
        const internalId = await rpc("iao_api_bind_operation", {
          p_key_hash: identity.hash, p_operation_id: operationId.toLowerCase(), p_create: action !== "status", p_scope: scope,
        }, signal);
        if (internalId === null && action === "status") return null;
        if (typeof internalId !== "string" || !UUID.test(internalId)) throw unavailable();
        const scoped = scopedHost(identity.hash, grant, operationId.toLowerCase(), internalId);
        const activeKey = grant.userId + ":" + internalId;
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        if (action === "consult") {
          const pending = active.get(activeKey) ?? new Set<AbortController>();
          pending.add(controller); active.set(activeKey, pending);
        }
        try {
          controller.signal.throwIfAborted();
          const result = action === "consult"
            ? await scoped.host.consult(grant.userId, { ...input!, operationId: internalId }, controller.signal)
            : await scoped.host[action](grant.userId, internalId, controller.signal);
          scoped.check();
          if (action === "cancel" && result?.cancelRequested) {
            for (const pending of active.get(activeKey) ?? []) pending.abort();
          }
          if (result && result.operationId !== internalId) throw unavailable();
          return result ? { ...result, operationId: operationId.toLowerCase() } : null;
        } catch (error) { scoped.check(); throw error; }
        finally {
          signal.removeEventListener("abort", abort);
          const pending = active.get(activeKey);
          pending?.delete(controller);
          if (pending?.size === 0) active.delete(activeKey);
        }
      })();
      pendingOperations.add(pending);
      const finished = () => { pendingOperations.delete(pending); };
      void pending.then(finished, finished);
      return pending;
    },
  };
}
