import PDFDocument from "pdfkit";
import { supabase } from "../db/supabase.js";
import type { ToolDefinition } from "../engine/types.js";
import { isOutputHttpUrl, isOutputObject, isOutputText, requireOutput } from "./response-validation.js";

const STORAGE_BUCKET = "agent-documents";

/** Génère un PDF simple (titre + paragraphes) et le stocke dans Supabase Storage. */
export const generatePdfTool: ToolDefinition<{ title: string; paragraphs: string[]; fileName: string }, { url: string }> = {
  name: "generate_pdf",
  description: "Génère un document PDF (facture, courrier, note) et le stocke, retourne son URL.",
  sensitive: false,
  async execute(params, ctx) {
    const buffer = await renderPdf(params.title, params.paragraphs);
    const path = `${ctx.userId}/${Date.now()}-${params.fileName}`;

    const { data: uploaded, error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, buffer, {
      contentType: "application/pdf",
      upsert: false,
    });

    if (error) throw new Error(`generate_pdf upload échoué: ${error.message}`);
    // The SDK constructs path locally; require the provider's id and bucket/object Key too.
    requireOutput(isOutputObject(uploaded) && isOutputText(uploaded.id) && uploaded.path === path
      && uploaded.fullPath === `${STORAGE_BUCKET}/${path}`, "PDF upload");

    const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
    requireOutput(isOutputObject(data) && isOutputHttpUrl(data.publicUrl), "PDF URL");
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
