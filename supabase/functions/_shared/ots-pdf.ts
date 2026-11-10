import { OtsHttpError } from "./ots-auth.ts";
import { fetchSignedPdf, OtsDocumentError } from "./ots-document.ts";

/** Compatibility facade; the bounded transport and admission policy stay unique. */
export async function signedPdf(
  submission: unknown,
  signal: AbortSignal = new AbortController().signal,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return (await fetchSignedPdf(submission, signal)).bytes;
  } catch (error) {
    if (error instanceof OtsDocumentError) throw new OtsHttpError(error.status, error.message);
    throw error;
  }
}
