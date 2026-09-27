import { createHash, randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import { supabase } from "../db/supabase.js";
import type { ToolDefinition } from "../engine/types.js";

const STORAGE_BUCKET = "agent-documents";

export const generatePdfTool: ToolDefinition<
  { title: string; paragraphs: string[]; fileName: string },
  { url: string; storagePath: string }
> = {
  name: "generate_pdf",
  description: "Génère un PDF privé et retourne un lien signé temporaire ainsi que son chemin de stockage.",
  sensitive: false,
  async execute(params, ctx) {
    if (typeof params.title !== "string" || !params.title.trim() || params.title.length > 500) throw new Error("Titre PDF invalide");
    if (!Array.isArray(params.paragraphs) || params.paragraphs.length > 200 ||
      params.paragraphs.some(p => typeof p !== "string" || p.length > 20_000)) {
      throw new Error("Paragraphes PDF invalides");
    }

    const safeFileName = safePdfName(params.fileName);
    const operationPart = ctx.operationId
      ? createHash("sha256").update(ctx.operationId).digest("hex")
      : randomUUID();
    const path = `${ctx.userId}/${operationPart}-${safeFileName}`;
    const buffer = await renderPdf(params.title.trim(), params.paragraphs);

    const bucket = supabase.storage.from(STORAGE_BUCKET);
    const { error } = await bucket.upload(path, buffer, {
      contentType: "application/pdf",
      upsert: false,
    });

    if (error) {
      // Un retry du même operationId peut retrouver exactement le même objet.
      const existing = await bucket.download(path);
      if (existing.error || !existing.data) {
        throw new Error("generate_pdf upload échoué");
      }
    }

    const signed = await bucket.createSignedUrl(path, 60 * 60);
    if (signed.error || !signed.data?.signedUrl) throw new Error("Impossible de signer le document PDF");
    return { url: signed.data.signedUrl, storagePath: path };
  },
};

function safePdfName(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 120 || /[\r\n\u0000]/.test(value)) {
    throw new Error("Nom de fichier PDF invalide");
  }
  const basename = value.trim().replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-");
  const withExtension = basename.toLowerCase().endsWith(".pdf") ? basename : `${basename}.pdf`;
  if (!withExtension || withExtension.startsWith(".")) throw new Error("Nom de fichier PDF invalide");
  return withExtension;
}

function renderPdf(title: string, paragraphs: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).text(title, { underline: true });
    doc.moveDown();
    doc.fontSize(11);
    for (const paragraph of paragraphs) {
      doc.text(paragraph);
      doc.moveDown(0.5);
    }

    doc.end();
  });
}
