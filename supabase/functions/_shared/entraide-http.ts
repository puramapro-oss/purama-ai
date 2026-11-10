import { rateLimit } from "./rate-limit.ts";

export type EntraideRateLimiter = (
  key: string,
  maxRequests: number,
  windowMs: number,
) => { allowed: boolean; remaining: number };

export class EntraideHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Headers;

  constructor(
    status: number,
    code: string,
    message = code,
    headers?: HeadersInit,
  ) {
    super(message);
    this.name = "EntraideHttpError";
    this.status = status;
    this.code = code;
    this.headers = new Headers(headers);
  }
}

/** Feature-local response helper: do not change response.ts for unrelated APIs. */
export function entraideJson(
  data: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), {
    status,
    headers: responseHeaders,
  });
}

/** Only explicitly classified errors may expose a message to the client. */
export function entraideErrorResponse(
  error: unknown,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  if (error instanceof EntraideHttpError) {
    error.headers.forEach((value, key) => responseHeaders.set(key, value));
    return entraideJson(
      { error: error.code, message: error.message },
      error.status,
      responseHeaders,
    );
  }
  return entraideJson(
    { error: "internal_error", message: "Erreur serveur" },
    500,
    responseHeaders,
  );
}

/** Bound the bytes actually read, including requests without Content-Length. */
export async function readEntraideJson(
  req: Request,
  maxBytes = 16_384,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("Invalid JSON body limit");
  }
  const declaredLength = Number(req.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new EntraideHttpError(
      413,
      "request_too_large",
      "Corps de requête trop volumineux",
    );
  }
  if (!req.body) {
    throw new EntraideHttpError(400, "invalid_request", "Corps JSON requis");
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new EntraideHttpError(
          413,
          "request_too_large",
          "Corps de requête trop volumineux",
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof EntraideHttpError) throw error;
    throw new EntraideHttpError(400, "invalid_request", "Corps JSON illisible");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new EntraideHttpError(400, "invalid_request", "Corps JSON invalide");
  }
}

/** Per-isolate abuse throttle only; business quotas need a database transaction. */
export function assertEntraideRateLimit(
  userId: string,
  bucket: string,
  maxRequests: number,
  windowMs = 60_000,
  limiter: EntraideRateLimiter = rateLimit,
): void {
  const result = limiter(`${bucket}:${userId}`, maxRequests, windowMs);
  if (!result.allowed) {
    throw new EntraideHttpError(
      429,
      "rate_limited",
      "Trop de requêtes, réessayez plus tard",
      {
        "Retry-After": String(Math.ceil(windowMs / 1_000)),
      },
    );
  }
}

/** Accept the Supabase gateway path and the local function path, with exact prefixes. */
export function entraideRouteParts(req: Request, endpoint: string): string[] {
  if (!/^[a-z0-9-]+$/.test(endpoint)) {
    throw new TypeError("Invalid endpoint name");
  }
  const pathname = new URL(req.url).pathname;
  const base = [`/functions/v1/${endpoint}`, `/${endpoint}`].find(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (!base) throw new EntraideHttpError(404, "not_found", "Route introuvable");

  const suffix = pathname.slice(base.length).replace(/\/$/, "");
  if (!suffix) return [];
  const encodedParts = suffix.slice(1).split("/");
  if (encodedParts.some((part) => part.length === 0)) {
    throw new EntraideHttpError(404, "not_found", "Route introuvable");
  }
  try {
    const parts = encodedParts.map((part) => decodeURIComponent(part));
    if (
      parts.some((part) =>
        /[/\\\u0000-\u001f\u007f]/.test(part) || part === "." || part === ".."
      )
    ) {
      throw new EntraideHttpError(404, "not_found", "Route introuvable");
    }
    return parts;
  } catch (error) {
    if (error instanceof EntraideHttpError) throw error;
    throw new EntraideHttpError(
      400,
      "invalid_request",
      "Chemin de requête invalide",
    );
  }
}
