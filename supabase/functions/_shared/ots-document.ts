import { DOCUSEAL_URL, DOCUSEAL_TOKEN } from "./docuseal.ts";
import { readBoundedBytes, RequestBodyError } from "./request-body.ts";

// Conservative internal policy, not a DocuSeal limit. Validate the real contract
// corpus before activation. These limits cannot be changed by an HTTP caller.
const MAX_METADATA_BYTES = 64_000; // Preserve the stricter existing admission cap.
const MAX_PDF_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10_000;

export class OtsDocumentError extends Error {
  constructor(readonly status: 409 | 502 | 503 | 504, message: string) {
    super(message);
    this.name = "OtsDocumentError";
  }
}

function cancelResponse(response: Response): void {
  try { void response.body?.cancel().catch(() => {}); } catch { /* A reader owns cancellation while locked. */ }
}

/** Resolve metadata and read the signed PDF under one monotonic budget. */
export async function fetchSignedPdf(submissionId: unknown, signal: AbortSignal): Promise<{
  bytes: Uint8Array<ArrayBuffer>;
  /** Recheck at the caller's hash/stamp boundary after asynchronous handoff. */
  assertCurrent: () => void;
}> {
  if (typeof submissionId !== "number" || !Number.isSafeInteger(submissionId) || submissionId <= 0) {
    throw new OtsDocumentError(409, "No signed submission linked");
  }
  const origin = new URL(DOCUSEAL_URL);
  if (origin.protocol !== "https:" || origin.username || origin.password || !DOCUSEAL_TOKEN) {
    throw new OtsDocumentError(503, "Document service unavailable");
  }
  const deadline = performance.now() + DOWNLOAD_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failure: OtsDocumentError | undefined;
  let rejectStopped: (error: OtsDocumentError) => void = () => {};
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  void stopped.catch(() => {});
  const stop = (status: 503 | 504) => {
    if (failure) return;
    failure = new OtsDocumentError(status, status === 504 ? "Signed PDF download deadline exceeded" : "Signed PDF download interrupted");
    rejectStopped(failure);
    controller.abort();
  };
  const onAbort = () => stop(503);
  const assertCurrent = () => {
    if (signal.aborted) onAbort();
    if (performance.now() >= deadline) stop(504);
    if (failure) throw failure;
  };

  const fetchResponse = async (url: string | URL, headers: HeadersInit): Promise<Response> => {
    assertCurrent();
    const pending = fetch(url, { method: "GET", headers, signal: controller.signal, redirect: "error", credentials: "omit" });
    // A transport may ignore abort and resolve after the caller has returned.
    void pending.then(response => { if (failure) cancelResponse(response); }, () => {});
    let response: Response;
    try {
      response = await Promise.race([pending, stopped]);
    } catch (error) {
      // A rejected transport must also respect a monotonic deadline/abort that
      // became observable before the timer callback could run.
      assertCurrent();
      throw error;
    }
    try { assertCurrent(); return response; }
    catch (error) { cancelResponse(response); throw error; }
  };

  const readResponse = async (response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> => {
    try {
      assertCurrent();
      if (!response.ok || response.redirected) throw new OtsDocumentError(502, "Failed to fetch signed document");
      const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
      // Fetch can decode gzip/br while retaining the encoded Content-Length.
      // Always count actual decoded bytes; compare lengths only for identity.
      const bytes = await readBoundedBytes({
        body: response.body, headers: response.headers, signal: controller.signal,
      }, { maxBytes, deadline, matchContentLength: !encoding || encoding === "identity" });
      assertCurrent();
      return bytes;
    } catch (error) {
      assertCurrent();
      if (error instanceof RequestBodyError) {
        if (error.status === 408) {
          stop(504);
          throw failure;
        }
        throw new OtsDocumentError(502, "Invalid signed document response");
      }
      throw error;
    } finally {
      cancelResponse(response);
    }
  };

  try {
    signal.addEventListener("abort", onAbort, { once: true });
    assertCurrent();
    timer = setTimeout(() => stop(504), Math.max(0, deadline - performance.now()));
    const metadataResponse = await fetchResponse(new URL(`/api/submissions/${submissionId}/documents?merge=true`, origin), {
      "X-Auth-Token": DOCUSEAL_TOKEN, "Content-Type": "application/json", "Accept": "application/json",
    });
    const metadataBytes = await readResponse(metadataResponse, MAX_METADATA_BYTES);
    assertCurrent();
    let docs: { id?: unknown; combined_document_url?: unknown; documents?: Array<{ url?: unknown }> };
    try {
      docs = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes));
      if (!docs || typeof docs !== "object" || Array.isArray(docs)) throw new Error("Invalid metadata");
    } catch {
      throw new OtsDocumentError(502, "Invalid signed document metadata");
    }
    assertCurrent();
    if (docs.id !== undefined && String(docs.id) !== String(submissionId)) {
      throw new OtsDocumentError(502, "Signed submission mismatch");
    }
    const url = docs.combined_document_url ??
      (Array.isArray(docs.documents) && docs.documents.length === 1 ? docs.documents[0]?.url : undefined);
    if (typeof url !== "string" || url.includes("\\")) throw new OtsDocumentError(502, "Invalid PDF location");
    const pdfUrl = new URL(url);
    // Preserve the established authority: storage hosts require a separate
    // deployment review, never a prefix or an arbitrary HTTPS URL from metadata.
    if (pdfUrl.origin !== origin.origin || pdfUrl.protocol !== "https:" ||
        pdfUrl.username || pdfUrl.password || pdfUrl.hash) {
      throw new OtsDocumentError(502, "Invalid PDF location");
    }
    const response = await fetchResponse(pdfUrl, { "X-Auth-Token": DOCUSEAL_TOKEN });
    const bytes = await readResponse(response, MAX_PDF_BYTES);
    assertCurrent();
    if (bytes.length < 5 || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
      throw new OtsDocumentError(502, "Signed PDF unavailable");
    }
    return { bytes, assertCurrent };
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
