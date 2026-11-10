export const FOUNDER_EMAIL = "matiss.frasne@gmail.com";

export type Metric = { status: "available"; value: number } | { status: "unavailable"; value: null };
export type RecentProfile = { id: string; full_name: string | null; created_at: string | null };
export type CountResult = { count: number | null; error: unknown };
export type RowsResult = { data: unknown; error: unknown };
export interface FounderIdentity {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
}
export interface DashboardReader {
  countProfiles(signal: AbortSignal): PromiseLike<CountResult>;
  countActiveSubscriptions(signal: AbortSignal): PromiseLike<CountResult>;
  countEnabledAgents(signal: AbortSignal): PromiseLike<CountResult>;
  recentProfiles(signal: AbortSignal): PromiseLike<RowsResult>;
}
export interface DashboardDependencies {
  founderUserId?: string;
  allowedOrigin?: string;
  authenticate(token: string, signal: AbortSignal): Promise<FounderIdentity | null>;
  createReader(): DashboardReader;
  rateLimit(key: string, maxRequests: number, windowMs: number): { allowed: boolean };
  now?: () => Date;
  /** Total authentication + complete SDK operations; production default is 8 seconds. */
  requestTimeoutMs?: number;
}
export interface DashboardSnapshot {
  version: 1;
  scope: "purama_ai";
  observedAt: string;
  metrics: { profiles: Metric; activeSubscriptions: Metric; enabledAgents: Metric };
  recentProfiles: { status: "available" | "unavailable"; items: RecentProfile[] };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailable = (): Metric => ({ status: "unavailable", value: null });

function configuredOwner(value: string | undefined): string | null {
  if (!value || value !== value.trim() || !UUID.test(value)) return null;
  const uuid = value.toLowerCase().replaceAll("-", "");
  // Reject repeated-digit placeholder UUIDs as well as invalid/nil UUIDs.
  const variableBits = uuid.slice(0, 12) + uuid.slice(13, 16) + uuid.slice(17);
  return /^([0-9a-f])\1+$/.test(variableBits) ? null : value.toLowerCase();
}

function configuredOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value);
    return origin.protocol === "https:" && origin.origin === value && !origin.username && !origin.password
      ? value : null;
  } catch {
    return null;
  }
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function withAbort<T>(operation: (signal: AbortSignal) => PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Request deadline reached"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw new Error("Request deadline reached");
      return operation(signal);
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function verifiedOwner(user: FounderIdentity, ownerId: string): boolean {
  return typeof user.id === "string" && user.id.toLowerCase() === ownerId
    && typeof user.email === "string" && user.email.trim().toLowerCase() === FOUNDER_EMAIL
    && timestamp(user.email_confirmed_at);
}

async function readCount(read: (signal: AbortSignal) => PromiseLike<CountResult>, signal: AbortSignal): Promise<Metric> {
  try {
    const result = await withAbort(read, signal);
    return !result.error && typeof result.count === "number" && Number.isSafeInteger(result.count) && result.count >= 0
      ? { status: "available", value: result.count } : unavailable();
  } catch {
    return unavailable();
  }
}

async function readRecent(read: (signal: AbortSignal) => PromiseLike<RowsResult>, signal: AbortSignal): Promise<DashboardSnapshot["recentProfiles"]> {
  try {
    const result = await withAbort(read, signal);
    if (result.error || !Array.isArray(result.data)) return { status: "unavailable", items: [] };
    const items: RecentProfile[] = [];
    const seen = new Set<string>();
    for (const row of result.data.slice(0, 10)) {
      if (!row || typeof row !== "object" || typeof row.id !== "string" || !UUID.test(row.id) || seen.has(row.id.toLowerCase())
        || (row.full_name !== null && (typeof row.full_name !== "string" || row.full_name.length > 500))
        || (row.created_at !== null && !timestamp(row.created_at))) {
        return { status: "unavailable", items: [] };
      }
      seen.add(row.id.toLowerCase());
      // Explicit projection: never forward email, metadata, or additional provider fields.
      items.push({ id: row.id, full_name: row.full_name, created_at: row.created_at });
    }
    return { status: "available", items };
  } catch {
    return { status: "unavailable", items: [] };
  }
}

export function createFounderDashboardHandler(deps: DashboardDependencies): (request: Request) => Promise<Response> {
  return async (request) => {
    const origin = request.headers.get("Origin");
    const allowedOrigin = configuredOrigin(deps.allowedOrigin);
    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Vary": "Authorization, Origin",
    });
    if (origin && origin === allowedOrigin) headers.set("Access-Control-Allow-Origin", origin);
    const respond = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers });

    // CORS is not authorization. Requests without Origin still pass every identity check below.
    if (origin !== null && origin !== allowedOrigin) return respond(403, "Origine non autorisée.");
    if (request.method === "OPTIONS") {
      const requestedMethod = request.headers.get("Access-Control-Request-Method");
      if (requestedMethod && requestedMethod !== "GET") {
        headers.set("Allow", "GET, OPTIONS");
        return respond(405, "Méthode non autorisée.");
      }
      headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "authorization, apikey, x-client-info, content-type");
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "GET") {
      headers.set("Allow", "GET, OPTIONS");
      return respond(405, "Méthode non autorisée.");
    }

    const ownerId = configuredOwner(deps.founderUserId);
    const timeoutMs = deps.requestTimeoutMs ?? 8_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) return respond(503, "Tableau de bord indisponible.");
    if (!ownerId) return respond(503, "Tableau de bord indisponible.");
    const authorization = request.headers.get("Authorization") ?? "";
    const token = authorization.length <= 8192 ? /^Bearer ([^\s]+)$/i.exec(authorization)?.[1] : undefined;
    if (!token) return respond(401, "Authentification requise.");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let user: FounderIdentity | null;
      try {
        user = await withAbort((signal) => deps.authenticate(token, signal), controller.signal);
      } catch {
        return respond(503, "Vérification de session indisponible.");
      }
      if (!user) return respond(401, "Session invalide.");
      if (!verifiedOwner(user, ownerId)) return respond(403, "Accès réservé au propriétaire.");

      try {
        // Existing in-memory limiter: best effort per isolate, not a distributed security boundary.
        if (!deps.rateLimit("founder-dashboard:" + ownerId, 30, 60_000).allowed) {
          headers.set("Retry-After", "60");
          return respond(429, "Trop de demandes. Réessaie dans un moment.");
        }
        // No privileged client is created and no database query occurs before the owner gate.
        const reader = deps.createReader();
        const [profiles, activeSubscriptions, enabledAgents, recentProfiles] = await Promise.all([
          readCount((signal) => reader.countProfiles(signal), controller.signal),
          readCount((signal) => reader.countActiveSubscriptions(signal), controller.signal),
          readCount((signal) => reader.countEnabledAgents(signal), controller.signal),
          readRecent((signal) => reader.recentProfiles(signal), controller.signal),
        ]);
        const snapshot: DashboardSnapshot = {
          version: 1,
          scope: "purama_ai",
          observedAt: (deps.now?.() ?? new Date()).toISOString(),
          metrics: { profiles, activeSubscriptions, enabledAgents },
          recentProfiles,
        };
        return new Response(JSON.stringify(snapshot), { status: 200, headers });
      } catch {
        return respond(503, "Tableau de bord indisponible.");
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
