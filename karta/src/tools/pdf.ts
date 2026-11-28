import PDFDocument from "pdfkit";
import { supabase } from "../db/supabase.js";
import { validateToolParams } from "../engine/tool-input.js";
import type { ToolDefinition } from "../engine/types.js";

const STORAGE_BUCKET = "agent-documents";

function assertSafePdfFileName(fileName: unknown): asserts fileName is string {
  const invalid = () => new Error("generate_pdf: nom de fichier invalide");
  if (
    typeof fileName !== "string" ||
    fileName.length < 1 ||
    fileName.length > 200 ||
    fileName !== fileName.trim() ||
    fileName === "." ||
    fileName === ".." ||
    /[\\/?#%\p{Cc}]/u.test(fileName)
  ) {
    throw invalid();
  }
  // The upload and public URL paths encode names differently. Reject malformed
  // UTF-16 before an upload could succeed but leave the caller without its URL.
  try {
    encodeURI(fileName);
  } catch {
    throw invalid();
  }
}

/** Génère un PDF simple (titre + paragraphes) et le stocke dans Supabase Storage. */
export const generatePdfTool: ToolDefinition<{ title: string; paragraphs: string[]; fileName: string }, { url: string }> = {
  name: "generate_pdf",
  description: "Génère un document PDF (facture, courrier, note) et le stocke, retourne son URL.",
  sensitive: false,
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 300 },
      paragraphs: { type: "array", items: { type: "string" } },
      fileName: {
        type: "string", minLength: 1, maxLength: 200,
        description: "Nom simple du PDF, sans chemin ni caractères / \\ ? # %.",
      },
    },
    required: ["title", "paragraphs", "fileName"],
    additionalProperties: false,
  },
  async execute(params, ctx) {
    const input = params && typeof params === "object" && !Array.isArray(params) ? { ...params } : params;
    validateToolParams(generatePdfTool, input);
    const { title, fileName } = input;
    assertSafePdfFileName(fileName);
    const paragraphs = [...input.paragraphs];
    const userId = ctx.userId;
    const buffer = await renderPdf(title, paragraphs);
    const path = `${userId}/${Date.now()}-${fileName}`;

    const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, buffer, {
      contentType: "application/pdf",
      upsert: false,
    });

    if (error) throw new Error(`generate_pdf upload échoué: ${error.message}`);

    const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
    return { url: data.publicUrl };
  },
};

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
