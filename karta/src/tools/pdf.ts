import PDFDocument from "pdfkit";
import { supabase } from "../db/supabase.js";
import type { ToolDefinition } from "../engine/types.js";
import { arraySchema, defineTool, objectSchema, stringSchema } from "./validation.js";

const STORAGE_BUCKET = "agent-documents";

/** Génère un PDF simple (titre + paragraphes) et le stocke dans Supabase Storage. */
export const generatePdfTool: ToolDefinition<{ title: string; paragraphs: string[]; fileName: string }, { url: string }> = defineTool({
  name: "generate_pdf",
  description: "Génère un document PDF (facture, courrier, note) et le stocke, retourne son URL.",
  sensitive: false,
  input: objectSchema({
    title: stringSchema({ maxLength: 512, pattern: "\\S" }),
    paragraphs: arraySchema(stringSchema({ minLength: 0, maxLength: 10_000 }), 100),
    fileName: stringSchema({ maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*\\.pdf$" }),
  }),
  async execute(params, ctx) {
    const buffer = await renderPdf(params.title, params.paragraphs);
    const path = `${ctx.userId}/${Date.now()}-${params.fileName}`;

    const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, buffer, {
      contentType: "application/pdf",
      upsert: false,
    });

    if (error) throw new Error(`generate_pdf upload échoué: ${error.message}`);

    const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
    return { url: data.publicUrl };
  },
});

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
