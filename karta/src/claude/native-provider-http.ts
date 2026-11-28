/** Native API transport shared by account discovery and inference. The caller
 * owns the deadline through runtime/bounded; this reader also bounds the body
 * and cancels late I/O. There are no retries, redirects or configurable hosts. */
export async function requestNativeProviderJson(options: {
  url: string;
  provider: "openai" | "google" | "xai";
  apiKey: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  fetch?: typeof fetch;
  signal: AbortSignal;
  maxBytes?: number;
}): Promise<Record<string, unknown>> {
  const unavailable = (): never => { throw new Error("Réponse du fournisseur indisponible"); };
  const origins = {
    openai: "https://api.openai.com", xai: "https://api.x.ai", google: "https://generativelanguage.googleapis.com",
  } as const;
  let response: Response | undefined;
  try {
    options.signal.throwIfAborted();
    const url = new URL(options.url);
    const path = options.provider === "google"
      ? options.method === "GET" ? url.pathname === "/v1beta/models"
        : /^\/v1beta\/models\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}:generateContent$/.test(url.pathname)
      : options.method === "GET" ? url.pathname === "/v1/models"
        || (options.provider === "xai" && url.pathname === "/v1/language-models")
        : url.pathname === "/v1/responses";
    const queryAllowed = options.method === "GET" && options.provider === "google"
      ? [...url.searchParams.keys()].every(key => ["pageSize", "pageToken"].includes(key)) : url.search === "";
    const maxBytes = options.maxBytes ?? 1_048_576;
    if (!path || !queryAllowed || url.origin !== origins[options.provider] || url.username || url.password || url.hash
      || typeof options.apiKey !== "string" || !options.apiKey || /\s/.test(options.apiKey)
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4_194_304
      || (options.method === "GET" && options.body !== undefined)) return unavailable();
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined && Buffer.byteLength(body, "utf8") > 2_097_152) return unavailable();
    const headers: Record<string, string> = options.provider === "google"
      ? { "x-goog-api-key": options.apiKey } : { Authorization: `Bearer ${options.apiKey}` };
    headers.Accept = "application/json";
    if (body !== undefined) headers["Content-Type"] = "application/json";
    response = await (options.fetch ?? fetch)(url.toString(), {
      method: options.method, headers, ...(body === undefined ? {} : { body }),
      redirect: "error", credentials: "omit", signal: options.signal,
    });
    if (options.signal.aborted || !response.ok || response.redirected || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      return unavailable();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0, reads = 0, empty = 0;
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    options.signal.addEventListener("abort", cancel, { once: true });
    try {
      while (true) {
        options.signal.throwIfAborted();
        if (++reads > 8192) return unavailable();
        const next = await reader.read();
        options.signal.throwIfAborted();
        if (next.done) break;
        size += next.value.byteLength;
        empty = next.value.byteLength === 0 ? empty + 1 : 0;
        if (size > maxBytes || empty > 64) return unavailable();
        chunks.push(next.value);
      }
    } catch {
      cancel();
      return unavailable();
    } finally {
      options.signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
    options.signal.throwIfAborted();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable();
    return value as Record<string, unknown>;
  } catch {
    // Provider bodies, URLs, headers and caller abort reasons may contain
    // private data. None is copied into the public failure or cycle logs.
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
    return unavailable();
  }
}
