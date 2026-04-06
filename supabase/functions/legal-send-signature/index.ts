// Legal Agent — Send a document for signature via DocuSeal
// POST { document_id, signers: [{name, email}] }
// 1. Fetch document
// 2. Generate a PDF from the markdown content via pdf-lib
// 3. Create a DocuSeal template (or submission) from the PDF
// 4. Get the signing URL and store it on the document
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const DOCUSEAL_URL = Deno.env.get("DOCUSEAL_URL") ?? "";
const DOCUSEAL_API_KEY = Deno.env.get("DOCUSEAL_API_KEY") ?? "";

interface SignerIn { name: string; email: string }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    if (!DOCUSEAL_URL || !DOCUSEAL_API_KEY) {
      return json({ error: "DocuSeal not configured" }, 503);
    }
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const token = auth.replace("Bearer ", "");

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      db: { schema: "purama_ai" },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;

    const { document_id, signers } = (await req.json()) as {
      document_id?: string;
      signers?: SignerIn[];
    };
    if (!document_id || !signers || signers.length === 0) {
      return json({ error: "document_id and signers required" }, 400);
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      db: { schema: "purama_ai" },
    });

    const { data: doc, error: dErr } = await admin
      .from("legal_documents")
      .select("*")
      .eq("id", document_id)
      .eq("user_id", userId)
      .single();
    if (dErr || !doc) return json({ error: "Document not found" }, 404);

    // 1. Render PDF from the document content (Markdown → plain wrapped text in PDF)
    const pdfBytes = await renderDocumentPdf(doc.title, doc.content_html);
    const pdfBase64 = bytesToBase64(pdfBytes);

    // 2. Upload to Storage (so we always have a downloadable copy)
    const storagePath = `${userId}/${doc.id}.pdf`;
    await fetch(
      `${SUPABASE_URL}/storage/v1/object/legal-documents/${storagePath}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/pdf",
          "x-upsert": "true",
        },
        body: pdfBytes,
      },
    );
    const signRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/legal-documents/${storagePath}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expiresIn: 60 * 60 * 24 * 30 }),
      },
    );
    const signJson = await signRes.json() as { signedURL?: string };
    const pdfUrl = signJson.signedURL ? `${SUPABASE_URL}/storage/v1${signJson.signedURL}` : null;

    // 3. Create DocuSeal template from the PDF
    const tplRes = await fetch(`${DOCUSEAL_URL}/api/templates/pdf`, {
      method: "POST",
      headers: {
        "X-Auth-Token": DOCUSEAL_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: doc.title,
        documents: [
          {
            name: `${doc.title}.pdf`,
            file: pdfBase64,
            // Place a single signature field at the bottom-right of the last page
            fields: signers.map((s, i) => ({
              name: `signature_${i + 1}`,
              type: "signature",
              role: s.name,
              areas: [{ x: 0.55, y: 0.85, w: 0.35, h: 0.08, page: 0 }],
            })),
          },
        ],
      }),
    });

    if (!tplRes.ok) {
      const t = await tplRes.text();
      console.error("[docuseal template]", t);
      return json({ error: "DocuSeal template creation failed", details: t }, 502);
    }
    const tplJson = await tplRes.json() as { id: number };

    // 4. Create a submission with the signers
    const subRes = await fetch(`${DOCUSEAL_URL}/api/submissions`, {
      method: "POST",
      headers: {
        "X-Auth-Token": DOCUSEAL_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        template_id: tplJson.id,
        send_email: true,
        submitters: signers.map((s, i) => ({
          name: s.name,
          email: s.email,
          role: s.name,
        })),
      }),
    });

    if (!subRes.ok) {
      const t = await subRes.text();
      console.error("[docuseal submission]", t);
      return json({ error: "DocuSeal submission failed", details: t }, 502);
    }
    const subJson = await subRes.json() as Array<{ id: number; slug: string; embed_src?: string }>;
    const submissionId = String(subJson[0]?.id ?? "");

    // 5. Update the document
    await admin
      .from("legal_documents")
      .update({
        status: "sent",
        content_pdf_url: pdfUrl,
        docuseal_submission_id: submissionId,
        signers: signers.map(s => ({ name: s.name, email: s.email, role: "signataire" })),
        sent_via: "docuseal",
        sent_at: new Date().toISOString(),
        requires_signature: true,
      })
      .eq("id", document_id);

    return json({ ok: true, docuseal_submission_id: submissionId, pdf_url: pdfUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[legal-send-signature]", msg);
    return json({ error: msg }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function renderDocumentPdf(title: string, content: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setProducer("Purama AI — Legal Agent");
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const purple = rgb(0.545, 0.361, 0.965);
  const dark = rgb(0.04, 0.04, 0.06);
  const muted = rgb(0.45, 0.45, 0.5);

  const pageW = 595, pageH = 842;
  const marginX = 50;
  const marginY = 60;
  const lineHeight = 13;
  const maxW = pageW - 2 * marginX;

  let page = pdf.addPage([pageW, pageH]);
  let y = pageH - marginY;

  // Header
  page.drawText("PURAMA AI", { x: marginX, y, size: 9, font: helvBold, color: purple });
  page.drawText("Document juridique", { x: marginX, y: y - 12, size: 8, font: helv, color: muted });
  y -= 40;

  // Title
  for (const line of wrapText(title, helvBold, 18, maxW)) {
    page.drawText(line, { x: marginX, y, size: 18, font: helvBold, color: dark });
    y -= 22;
  }
  y -= 10;

  // Strip basic markdown formatting for the PDF (the visual rendering uses
  // react-markdown in the UI; here we just need a clean readable text fallback).
  const cleaned = content
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  const paragraphs = cleaned.split(/\n\n+/);
  for (const para of paragraphs) {
    const lines = wrapText(para.replace(/\n/g, " "), helv, 10, maxW);
    for (const line of lines) {
      if (y < marginY + 80) {
        page = pdf.addPage([pageW, pageH]);
        y = pageH - marginY;
      }
      page.drawText(line, { x: marginX, y, size: 10, font: helv, color: dark });
      y -= lineHeight;
    }
    y -= 6;
  }

  // Make sure there's room for the signature on the last page
  if (y < 200) {
    page = pdf.addPage([pageW, pageH]);
    y = pageH - marginY;
  }

  return await pdf.save();
}

function wrapText(text: string, font: Awaited<ReturnType<PDFDocument["embedFont"]>>, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (font.widthOfTextAtSize(test, size) > maxWidth) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}
