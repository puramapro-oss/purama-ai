/** Pure, bounded decoding of the inline plain-text representation returned by Gmail.
 * HTML, attached messages/files and externally stored bodies are never guessed or fetched.
 */
export const GMAIL_TEXT_LIMIT = 64 * 1024;
export type GmailBodyStatus = "complete" | "unsupported" | "too_large" | "invalid";
export interface GmailBodyContent {
  body: string | null;
  bodyStatus: GmailBodyStatus;
  bodyNotice?: string;
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

/** Header names are case-insensitive; ambiguous duplicates are rejected. */
export function gmailHeader(payload: unknown, name: string): string | undefined {
  const headers = record(payload)?.headers;
  if (headers === undefined) return undefined;
  if (!Array.isArray(headers) || headers.length > 200) throw new Error("En-têtes Gmail invalides");
  const values = headers.filter(h => typeof record(h)?.name === "string" && (record(h)!.name as string).toLowerCase() === name.toLowerCase());
  if (values.length > 1) throw new Error(`En-tête Gmail ${name} ambigu`);
  if (values.length === 0) return undefined;
  const value = record(values[0])?.value;
  if (typeof value !== "string" || value.length > 8192 || /[\r\n\0]/.test(value)) throw new Error(`En-tête Gmail ${name} invalide`);
  return value;
}

export function extractGmailPlainText(payload: unknown): GmailBodyContent {
  let visited = 0;
  let bytes = 0;
  const fail = (bodyStatus: GmailBodyStatus, bodyNotice: string): GmailBodyContent => ({ body: null, bodyStatus, bodyNotice });
  const walk = (input: unknown, depth: number): GmailBodyContent => {
    if (++visited > 100 || depth > 12) return fail("invalid", "Structure MIME trop complexe");
    const part = record(input);
    if (!part || typeof part.mimeType !== "string") return fail("invalid", "Structure MIME invalide");
    const mime = part.mimeType.toLowerCase();
    const disposition = gmailHeader(part, "Content-Disposition") ?? "";
    if ((typeof part.filename === "string" && part.filename.length > 0) || /^attachment(?:;|$)/i.test(disposition)) {
      return fail("unsupported", "Pièce jointe non lue");
    }
    if (mime.startsWith("multipart/")) {
      if (!Array.isArray(part.parts) || part.parts.length === 0 || part.parts.length > 100) return fail("invalid", "Parties MIME invalides");
      const children = part.parts.map(child => walk(child, depth + 1));
      const invalid = children.find(child => child.bodyStatus === "invalid" || child.bodyStatus === "too_large");
      if (invalid) return invalid;
      const complete = children.filter(child => child.bodyStatus === "complete");
      if (!complete.length) return fail("unsupported", "Aucune représentation text/plain lisible");
      if (mime === "multipart/alternative") return complete[0];
      // A text-only inline attachment is not silently treated as the main message.
      const unsupportedInline = part.parts.some((child, index) => {
        const p = record(child);
        return children[index]?.bodyStatus === "unsupported" && p !== null &&
          !p.filename && !/^attachment(?:;|$)/i.test(gmailHeader(p, "Content-Disposition") ?? "");
      });
      if (unsupportedInline) return fail("unsupported", "Une partie textuelle ne peut pas être lue intégralement");
      return { body: complete.map(child => child.body).join("\n\n"), bodyStatus: "complete" };
    }
    if (mime !== "text/plain") return fail("unsupported", "Contenu non text/plain : lecture spécialisée nécessaire");
    const contentType = gmailHeader(part, "Content-Type") ?? "text/plain; charset=utf-8";
    const charset = /(?:^|;)\s*charset\s*=\s*"?([^;"\s]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? "utf-8";
    if (!["utf-8", "utf8", "us-ascii", "ascii"].includes(charset)) return fail("unsupported", "Encodage textuel non pris en charge");
    const rawBody = record(part.body);
    if (!rawBody) return fail("invalid", "Corps MIME absent");
    if (rawBody.attachmentId !== undefined && rawBody.data === undefined) return fail("unsupported", "Texte stocké séparément, non chargé");
    if (typeof rawBody.data !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(rawBody.data)) return fail("invalid", "Encodage base64url invalide");
    if (rawBody.data.length > Math.ceil(GMAIL_TEXT_LIMIT / 3) * 4) return fail("too_large", "Texte au-delà de la limite de 64 Kio ; aucun extrait présenté comme complet");
    const unpadded = rawBody.data.replace(/=+$/, "");
    if (rawBody.data.includes("=") && rawBody.data.length % 4 !== 0) return fail("invalid", "Padding base64url invalide");
    if (unpadded.length % 4 === 1) return fail("invalid", "Encodage base64url invalide");
    const decoded = Buffer.from(unpadded, "base64url");
    if (decoded.toString("base64url") !== unpadded) return fail("invalid", "Encodage base64url non canonique");
    if (rawBody.size !== undefined && (!Number.isSafeInteger(rawBody.size) || rawBody.size !== decoded.length)) return fail("invalid", "Taille MIME incohérente");
    bytes += decoded.length;
    if (bytes > GMAIL_TEXT_LIMIT) return fail("too_large", "Texte au-delà de la limite de 64 Kio ; aucun extrait présenté comme complet");
    if ((charset === "ascii" || charset === "us-ascii") && decoded.some(byte => byte > 127)) return fail("invalid", "Texte non ASCII");
    try {
      const body = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
      if (body.includes("\0")) return fail("invalid", "Texte contenant un caractère nul");
      return { body, bodyStatus: "complete" };
    } catch {
      return fail("invalid", "Texte UTF-8 invalide");
    }
  };
  try { return walk(payload, 0); } catch { return fail("invalid", "En-têtes MIME invalides ou ambigus"); }
}

/** Bounds bytes before JSON decoding. Content-Length alone is never trusted. */
export async function readBoundedGmailJson(response: Response): Promise<unknown> {
  const maxBytes = 2 * 1024 * 1024;
  if (!response.body) throw new Error("Réponse Gmail vide");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error("Réponse Gmail trop volumineuse");
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
