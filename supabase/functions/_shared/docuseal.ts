// Shared DocuSeal client + helpers for edge functions
// Imported by contracts-create, contracts-webhook, contracts-get, etc.

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-purama-service-token",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

export const DOCUSEAL_URL = Deno.env.get("DOCUSEAL_API_URL") ?? "https://docuseal.purama.dev";
export const DOCUSEAL_TOKEN = Deno.env.get("DOCUSEAL_API_TOKEN") ?? "";
export const DOCUSEAL_WEBHOOK_SECRET = Deno.env.get("DOCUSEAL_WEBHOOK_SECRET") ?? "";

export class DocusealError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "DocusealError";
    this.status = status;
    this.body = body;
  }
}

/** Read-only metadata: one request, a total 10s deadline and at most 1 MiB.
 * Writes keep their existing transport: an uncertain write cannot be retried
 * or interpreted as absent merely because this read budget has expired.
 */
async function readDocusealJson<T>(path: string): Promise<T> {
  if (!DOCUSEAL_TOKEN) throw new DocusealError("DocuSeal credential unavailable", 503, null);
  const controller = new AbortController();
  const deadline = performance.now() + 10_000;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectDeadline: (error: DocusealError) => void = () => {};
  const expired = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  void expired.catch(() => {});
  const timeoutError = () => new DocusealError("DocuSeal read deadline exceeded", 504, null);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; rejectDeadline(timeoutError()); controller.abort(); }, 10_000);
  const bounded = async <V>(work: Promise<V>): Promise<V> => {
    if (performance.now() >= deadline) throw timeoutError();
    const value = await Promise.race([work, expired]);
    if (performance.now() >= deadline) throw timeoutError();
    return value;
  };
  const cancel = (body: ReadableStream<Uint8Array> | null | undefined) => {
    try { void Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* Best effort, never a second wait. */ }
  };
  try {
    response = await bounded<Response>(fetch(`${DOCUSEAL_URL}${path}`, {
      method: "GET",
      headers: { "X-Auth-Token": DOCUSEAL_TOKEN, "Content-Type": "application/json", "Accept": "application/json" },
      redirect: "error", credentials: "omit", signal: controller.signal,
    }).then(value => { if (controller.signal.aborted) cancel(value.body); return value; }));
    if (response.redirected) throw new DocusealError("DocuSeal redirect rejected", 502, null);
    const maximum = 1024 * 1024;
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximum)) {
      throw new DocusealError("DocuSeal response size rejected", 502, null);
    }
    if (response.status === 204) return {} as T;
    reader = response.body?.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parts: string[] = [];
    let bytes = 0, emptyChunks = 0;
    while (reader) {
      const part = await bounded(reader.read());
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximum || (part.value.byteLength === 0 && ++emptyChunks > 64)) {
        throw new DocusealError("DocuSeal response size rejected", 502, null);
      }
      parts.push(decoder.decode(part.value, { stream: true }));
    }
    parts.push(decoder.decode());
    const text = parts.join("");
    let data: unknown;
    try { data = JSON.parse(text); }
    catch {
      if (response.ok) throw new DocusealError("Invalid DocuSeal JSON response", 502, null);
      data = text;
    }
    if (!response.ok) throw new DocusealError(`DocuSeal GET ${path} → ${response.status}`, response.status, data);
    return data as T;
  } catch (error) {
    controller.abort();
    if (reader) {
      try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* The deadline also bounds cleanup. */ }
    } else cancel(response?.body);
    if (timedOut || performance.now() >= deadline) throw timeoutError();
    if (error instanceof DocusealError) throw error;
    throw new DocusealError("DocuSeal read unavailable", 502, null);
  } finally {
    clearTimeout(timer);
    try { reader?.releaseLock(); } catch { /* A pending read is already observed by the deadline race. */ }
  }
}

export async function docusealFetch<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  if (method === "GET") return readDocusealJson<T>(path);
  const res = await fetch(`${DOCUSEAL_URL}${path}`, {
    method,
    headers: {
      "X-Auth-Token": DOCUSEAL_TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let errBody: unknown;
    try { errBody = await res.json(); } catch { errBody = await res.text(); }
    throw new DocusealError(`DocuSeal ${method} ${path} → ${res.status}`, res.status, errBody);
  }
  if (res.status === 204) return {} as T;
  return await res.json() as T;
}

// ─── HMAC webhook validation (Web Crypto, Deno-native) ────────────────
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !secret) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  const received = signatureHeader.startsWith("sha256=") ? signatureHeader.slice(7) : signatureHeader;
  if (expected.length !== received.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) result |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return result === 0;
}

// ─── Cross-app JWT verification (service-to-service) ──────────────────
export interface CrossAppJwtPayload {
  iss: string;
  aud: string;
  app_slug: string;
  iat: number;
  exp: number;
  jti?: string;
}

export async function verifyCrossAppJwt(
  token: string,
  secrets: string[],
): Promise<CrossAppJwtPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  const [encHeader, encPayload, encSig] = parts;
  const signingInput = `${encHeader}.${encPayload}`;

  const receivedSig = base64UrlDecode(encSig);
  let valid = false;
  for (const secret of secrets) {
    const expected = await hmacSha256Bytes(secret, signingInput);
    if (bytesEqual(expected, receivedSig)) { valid = true; break; }
  }
  if (!valid) throw new Error("Invalid JWT signature");

  const payloadJson = new TextDecoder().decode(base64UrlDecode(encPayload));
  const payload = JSON.parse(payloadJson) as CrossAppJwtPayload;
  if (payload.aud !== "purama-contracts-hub") throw new Error("Invalid JWT aud");
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp + 30 < now) throw new Error("JWT expired");
  return payload;
}

async function hmacSha256Bytes(secret: string, data: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(sig);
}

function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function corsResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export function errorResponse(message: string, status = 400, details?: unknown): Response {
  return corsResponse({ error: message, ...(details ? { details } : {}) }, status);
}
