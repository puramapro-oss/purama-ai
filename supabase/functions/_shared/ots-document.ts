import { DOCUSEAL_URL, DOCUSEAL_TOKEN } from "./docuseal.ts";
import { readBoundedBytes, RequestBodyError } from "./request-body.ts";

// Conservative internal policy, not a DocuSeal limit. Validate the real contract
// corpus before activation. These limits cannot be changed by an HTTP caller.
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_PDF_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10_000;

export class OtsDocumentError extends Error {
  constructor(readonly status: 404 | 502 | 503 | 504, message: string) {
    super(message);
    this.name = "OtsDocumentError";
  }
}

function cancelResponse(response: Response): void {
  try { void response.body?.cancel().catch(() => {}); } catch { /* A reader owns cancellation while locked. */ }
}

/** Resolve metadata and read the signed PDF under one monotonic budget. */
export async function fetchSignedPdf(submissionId: string | number, signal: AbortSignal): Promise<{
  bytes: Uint8Array<ArrayBuffer>;
  /** Recheck at the caller's hash/stamp boundary after asynchronous handoff. */
  assertCurrent: () => void;
}> {
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
    const pending = fetch(url, { method: "GET", headers, signal: controller.signal, redirect: "error" });
    // A transport may ignore abort and resolve after the caller has returned.
    void pending.then(response => { if (failure) cancelResponse(response); }, () => {});
    const response = await Promise.race([pending, stopped]);
    try { assertCurrent(); return response; }
    catch (error) { cancelResponse(response); throw error; }
  };

  const readResponse = async (response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> => {
    try {
      assertCurrent();
      if (!response.ok) throw new OtsDocumentError(502, "Failed to fetch signed document");
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
    const metadataResponse = await fetchResponse(`${DOCUSEAL_URL}/api/submissions/${submissionId}/documents`, {
      "X-Auth-Token": DOCUSEAL_TOKEN, "Content-Type": "application/json", "Accept": "application/json",
    });
    const metadataBytes = await readResponse(metadataResponse, MAX_METADATA_BYTES);
    assertCurrent();
    let docs: { combined_document_url?: unknown; documents?: Array<{ url?: unknown }> };
    try {
      docs = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes));
      if (!docs || typeof docs !== "object" || Array.isArray(docs)) throw new Error("Invalid metadata");
    } catch {
      throw new OtsDocumentError(502, "Invalid signed document metadata");
    }
    assertCurrent();
    const url = docs.combined_document_url ?? docs.documents?.[0]?.url;
    if (!url) throw new OtsDocumentError(404, "No signed PDF available");
    if (typeof url !== "string") throw new OtsDocumentError(502, "Invalid PDF location");
    const pdfUrl = new URL(url);
    const sameOrigin = pdfUrl.origin === new URL(DOCUSEAL_URL).origin;
    if (pdfUrl.username || pdfUrl.password ||
        (pdfUrl.protocol !== "https:" && !(sameOrigin && pdfUrl.protocol === "http:"))) {
      throw new OtsDocumentError(502, "Invalid PDF location");
    }
    const response = await fetchResponse(pdfUrl, sameOrigin ? { "X-Auth-Token": DOCUSEAL_TOKEN } : {});
    const bytes = await readResponse(response, MAX_PDF_BYTES);
    assertCurrent();
    return { bytes, assertCurrent };
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
