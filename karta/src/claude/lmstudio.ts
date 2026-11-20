import type { ClientOptions } from "@anthropic-ai/sdk";

/** Explicit component integration. The production singleton never selects this route. */
export interface LmStudioOptions {
  /** Exact loaded instance id from LM Studio; never a guessed catalog alias. */
  readonly model: string;
  readonly baseURL?: string;
  /** LM Studio token only; cloud credentials are never inherited. */
  readonly apiKey?: string;
}

const busyOrigins = new Set<string>();
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function localOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Adresse LM Studio invalide"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("LM Studio exige une origine HTTP locale sans chemin ni identifiants");
  }
  // Avoid DNS resolution even for localhost. Neither LAN nor public hosts are accepted.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.origin;
}

async function readBody(response: Response, signal?: AbortSignal | null): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Réponse locale absente");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Réponse locale trop volumineuse");
      chunks.push(next.value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body;
  } finally {
    // Cancellation must not delay an already bounded operation.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Reuse Messages validation and usage receipts in real.ts. A loaded GGUF/MLX
 * instance is required before sending any prompt; no load/download/start API.
 * This checks the local server's report, not its honesty or whole-machine egress.
 */
export function createLmStudioTransport(options: LmStudioOptions) {
  const origin = localOrigin(options.baseURL ?? "http://127.0.0.1:1234");
  const model = options.model;
  if (typeof model !== "string" || model.length < 1 || model.length > 200
    || !/^[A-Za-z0-9]/.test(model) || /[^A-Za-z0-9_.:/@-]/.test(model)) {
    throw new Error("Identifiant du modèle LM Studio invalide");
  }
  const token = options.apiKey;
  if (token !== undefined && (typeof token !== "string" || !token.trim()
    || token.length > 4096 || /[^\x21-\x7e]/.test(token))) {
    throw new Error("Jeton LM Studio invalide");
  }
  const transport = globalThis.fetch.bind(globalThis);
  const request = async (path: "/api/v1/models" | "/v1/messages", init: RequestInit): Promise<Response> => {
    init.signal?.throwIfAborted();
    const safeInit = {
      ...init, redirect: "error" as const, credentials: "omit" as const, cache: "no-store" as const,
    };
    const response = await transport(`${origin}${path}`, safeInit);
    if (response.redirected || (response.url && response.url !== `${origin}${path}`)
      || response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("Redirection locale refusée");
    }
    const body = await readBody(response, init.signal);
    // The SDK sees a bounded body; it cannot follow a redirect or log a prompt.
    return new Response(body, { status: response.status, headers: response.headers });
  };
  const fetchMessages: typeof globalThis.fetch = async (resource, init) => {
    const url = resource instanceof Request ? resource.url : String(resource);
    if (url !== `${origin}/v1/messages` || init?.method !== "POST") {
      throw new Error("Destination LM Studio refusée");
    }
    const headers = new Headers(init.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    headers.set("x-api-key", token ?? "lm-studio-local");
    return request("/v1/messages", { ...init, headers });
  };
  const clientOptions: Partial<ClientOptions> = {
    baseURL: origin,
    apiKey: token ?? "lm-studio-local",
    authToken: null,
    fetch: fetchMessages,
    fetchOptions: { redirect: "error", credentials: "omit" },
  };

  async function run<T>(signal: AbortSignal, needsTools: boolean, action: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (busyOrigins.has(origin)) throw new Error("Une inférence locale est déjà en cours");
    busyOrigins.add(origin);
    try {
      const response = await request("/api/v1/models", {
        method: "GET", signal,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error("Inventaire LM Studio indisponible");
      const value: unknown = await response.json();
      if (!record(value) || !Array.isArray(value.models)) throw new Error("Inventaire LM Studio invalide");
      const matches = value.models.flatMap((entry: unknown) => {
        if (!record(entry) || !Array.isArray(entry.loaded_instances)) return [];
        return entry.loaded_instances
          .filter((instance: unknown) => record(instance) && instance.id === model)
          .map(() => entry);
      });
      if (matches.length !== 1) throw new Error("Modèle local chargé introuvable ou ambigu");
      const entry = matches[0] as Record<string, unknown>;
      if (entry.type !== "llm" || !["gguf", "mlx"].includes(String(entry.format))
        || entry.remote_host || entry.remote_model
        || (needsTools && (!record(entry.capabilities) || entry.capabilities.trained_for_tool_use !== true))) {
        throw new Error("Modèle local incompatible avec cette demande");
      }
      signal.throwIfAborted();
      return await action();
    } finally { busyOrigins.delete(origin); }
  }
  return { model, clientOptions, run };
}
