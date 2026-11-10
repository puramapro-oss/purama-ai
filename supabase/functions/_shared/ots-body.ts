import { readRequestText, RequestBodyError } from "./request-body.ts";

// Preserve the existing JSON-reader API while sharing one bounded transport.
export { RequestBodyError as OtsHttpError } from "./request-body.ts";

export async function readOtsBody(
  req: Request,
  maxBytes = 4096,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const text = await readRequestText(req, { maxBytes, timeoutMs });
  try {
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid shape");
    return body as Record<string, unknown>;
  } catch {
    throw new RequestBodyError(400, "Invalid JSON");
  }
}
