import { DOCUSEAL_URL, DOCUSEAL_TOKEN } from "./docuseal.ts";
import { OtsHttpError } from "./ots-auth.ts";
import { cancelResponseQuietly, createRequestDeadline } from "../../../src/lib/request-deadline.ts";

async function boundedResponse(response: Response, maximum: number, deadline: ReturnType<typeof createRequestDeadline>): Promise<Uint8Array> {
  if (!response.ok || response.redirected) { cancelResponseQuietly(response.body); throw new OtsHttpError(502, "Signed document unavailable"); }
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) { cancelResponseQuietly(response.body); throw new OtsHttpError(502, "Signed document too large"); }
  const reader = response.body?.getReader();
  if (!reader) throw new OtsHttpError(502, "Signed document unavailable");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await deadline.wait(() => reader.read()); if (done) break;
      size += value.length;
      if (size > maximum) throw new OtsHttpError(502, "Signed document too large");
      if (value.length) chunks.push(value);
    }
  } catch (error) { cancelResponseQuietly(reader); throw error; }
  finally { try { reader.releaseLock(); } catch { /* Pending adapters may retain the reader lock. */ } }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  deadline.check(); return bytes;
}
export async function signedPdf(submission: unknown): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(submission) || (submission as number) <= 0) throw new OtsHttpError(409, "No signed submission linked");
  const origin = new URL(DOCUSEAL_URL);
  if (origin.protocol !== "https:" || origin.username || origin.password || !DOCUSEAL_TOKEN) throw new OtsHttpError(503, "Document service unavailable");
  const deadline = createRequestDeadline(15_000);
  try {
    const metadata = await deadline.fetch(new URL(`/api/submissions/${submission}/documents?merge=true`, origin), {
      headers: { "X-Auth-Token": DOCUSEAL_TOKEN, Accept: "application/json" }, redirect: "error", credentials: "omit",
    });
    const data = JSON.parse(new TextDecoder().decode(await boundedResponse(metadata, 64_000, deadline))) as { id?: unknown; combined_document_url?: unknown; documents?: Array<{ url?: unknown }> };
    if (!data || typeof data !== "object" || (data.id !== undefined && String(data.id) !== String(submission))) throw new OtsHttpError(502, "Signed submission mismatch");
    const candidate = data.combined_document_url ?? (Array.isArray(data.documents) && data.documents.length === 1 ? data.documents[0]?.url : undefined);
    if (typeof candidate !== "string" || candidate.includes("\\")) throw new OtsHttpError(502, "Signed document unavailable");
    const target = new URL(candidate);
    // This integration uses the configured DocuSeal origin. Additional storage
    // authorities require an explicit deployment review, never a string prefix.
    if (target.origin !== origin.origin || target.protocol !== "https:" || target.username || target.password || target.hash) throw new OtsHttpError(502, "Signed document origin rejected");
    const response = await deadline.fetch(target, { headers: { "X-Auth-Token": DOCUSEAL_TOKEN }, redirect: "error", credentials: "omit" });
    const bytes = await boundedResponse(response, 20 * 1024 * 1024, deadline);
    if (bytes.length < 5 || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new OtsHttpError(502, "Signed PDF unavailable");
    const result = new Uint8Array(bytes);
    deadline.check(); return result;
  } catch (error) {
    if (error instanceof OtsHttpError) throw error;
    throw new OtsHttpError(502, "Signed document unavailable");
  } finally { deadline.close(); }
}
