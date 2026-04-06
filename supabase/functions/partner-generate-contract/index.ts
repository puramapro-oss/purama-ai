// Partner Agent — Generate a partnership contract via DocuSeal
// POST { prospect_id }
// 1. Fetch prospect + sender config (signature image url)
// 2. Claude rédige le contenu juridique du contrat de partenariat
// 3. Render PDF with both signature blocks (sender + prospect)
// 4. Create DocuSeal template + submission
// 5. Update prospect (contract_sent_at, contract_url, status)
// 6. Send notification to prospect via Resend
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const DOCUSEAL_URL = Deno.env.get("DOCUSEAL_URL") ?? "";
const DOCUSEAL_API_KEY = Deno.env.get("DOCUSEAL_API_KEY") ?? "";

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

    const { prospect_id } = (await req.json()) as { prospect_id?: string };
    if (!prospect_id) return json({ error: "prospect_id required" }, 400);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      db: { schema: "purama_ai" },
    });

    const { data: prospect, error: pErr } = await admin
      .from("partner_prospects")
      .select("*")
      .eq("id", prospect_id)
      .eq("user_id", userId)
      .single();
    if (pErr || !prospect) return json({ error: "Prospect not found" }, 404);
    if (!prospect.email) return json({ error: "Prospect has no email" }, 400);

    const { data: cfg, error: cErr } = await admin
      .from("partner_agent_config")
      .select("*")
      .eq("user_id", userId)
      .single();
    if (cErr || !cfg) return json({ error: "Config missing" }, 400);

    // 1. Claude rédige le contenu juridique
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 3000,
        system: `Tu rédiges un contrat de partenariat français complet et conforme.
Tu retournes UNIQUEMENT le contenu du contrat en texte brut (pas de markdown), structuré en articles numérotés, prêt à être imprimé sur PDF.
Le contrat doit inclure :
- Identité des parties (Purama et le partenaire)
- Article 1 : Objet du partenariat
- Article 2 : Engagements du partenaire
- Article 3 : Engagements de Purama
- Article 4 : Commissions (${cfg.commission_first_payment}% sur le 1er paiement, ${cfg.commission_recurring}% récurrent)
- Article 5 : Modalités de versement
- Article 6 : Durée et résiliation
- Article 7 : Confidentialité
- Article 8 : Propriété intellectuelle
- Article 9 : Responsabilité et garanties
- Article 10 : Loi applicable et juridiction (droit français)
- Bloc signature pour les deux parties
Pas de placeholder type [INSÉRER X], utilise les valeurs ci-dessous.`,
        messages: [{
          role: "user",
          content: `Émetteur :
${cfg.company_name}, représenté par ${cfg.sender_name} (${cfg.sender_title ?? "Fondateur"})
Email : ${cfg.sender_email}

Partenaire :
${prospect.name}
${prospect.email}
${prospect.website ? `Site : ${prospect.website}` : ""}
Type : ${prospect.type ?? "—"}
${prospect.niche ? `Niche : ${prospect.niche}` : ""}

Date : ${new Date().toLocaleDateString("fr-FR")}

Génère le contrat complet maintenant.`,
        }],
      }),
    });
    if (!claudeRes.ok) {
      const t = await claudeRes.text();
      return json({ error: "Claude failed", details: t }, 502);
    }
    const claudeJson = await claudeRes.json() as { content: Array<{ text: string }> };
    const contractText = claudeJson.content?.[0]?.text ?? "";

    // 2. Render PDF with optional sender signature image
    let signatureImageBytes: Uint8Array | null = null;
    if (cfg.signature_image_url) {
      try {
        const imgRes = await fetch(cfg.signature_image_url);
        if (imgRes.ok) {
          signatureImageBytes = new Uint8Array(await imgRes.arrayBuffer());
        }
      } catch (e) { console.warn("[partner-contract] signature fetch failed", e); }
    }

    const pdfBytes = await renderContractPdf(
      `Contrat de partenariat — ${cfg.company_name} × ${prospect.name}`,
      contractText,
      {
        senderName: cfg.signature_name ?? cfg.sender_name ?? "",
        senderTitle: cfg.signature_title ?? cfg.sender_title ?? "",
        partnerName: prospect.name,
        signatureImageBytes,
      },
    );
    const pdfBase64 = bytesToBase64(pdfBytes);

    // 3. Upload to Storage
    const storagePath = `${userId}/${prospect_id}.pdf`;
    await fetch(
      `${SUPABASE_URL}/storage/v1/object/partner-contracts/${storagePath}`,
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
      `${SUPABASE_URL}/storage/v1/object/sign/partner-contracts/${storagePath}`,
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

    // 4. Create DocuSeal template
    const tplRes = await fetch(`${DOCUSEAL_URL}/api/templates/pdf`, {
      method: "POST",
      headers: {
        "X-Auth-Token": DOCUSEAL_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `Contrat partenariat ${prospect.name}`,
        documents: [{
          name: `contrat-${prospect_id}.pdf`,
          file: pdfBase64,
          fields: [
            {
              name: "signature_partenaire",
              type: "signature",
              role: prospect.name,
              areas: [{ x: 0.55, y: 0.85, w: 0.35, h: 0.08, page: 0 }],
            },
          ],
        }],
      }),
    });
    if (!tplRes.ok) {
      const t = await tplRes.text();
      console.error("[docuseal template]", t);
      return json({ error: "DocuSeal template creation failed", details: t }, 502);
    }
    const tplJson = await tplRes.json() as { id: number };

    // 5. Create submission for the prospect
    const subRes = await fetch(`${DOCUSEAL_URL}/api/submissions`, {
      method: "POST",
      headers: {
        "X-Auth-Token": DOCUSEAL_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        template_id: tplJson.id,
        send_email: true,
        submitters: [{
          name: prospect.name,
          email: prospect.email,
          role: prospect.name,
        }],
      }),
    });
    if (!subRes.ok) {
      const t = await subRes.text();
      console.error("[docuseal submission]", t);
      return json({ error: "DocuSeal submission failed", details: t }, 502);
    }
    const subJson = await subRes.json() as Array<{ id: number; slug: string; embed_src?: string }>;
    const submissionId = String(subJson[0]?.id ?? "");
    const signingUrl = subJson[0]?.embed_src ?? null;

    // 6. Update prospect
    await admin
      .from("partner_prospects")
      .update({
        status: "contract_sent",
        contract_sent_at: new Date().toISOString(),
        contract_url: pdfUrl,
      })
      .eq("id", prospect_id);

    return json({
      ok: true,
      docuseal_submission_id: submissionId,
      pdf_url: pdfUrl,
      signing_url: signingUrl,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[partner-generate-contract]", msg);
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

async function renderContractPdf(
  title: string,
  content: string,
  meta: {
    senderName: string;
    senderTitle: string;
    partnerName: string;
    signatureImageBytes: Uint8Array | null;
  },
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setProducer("Purama AI — Partner Agent");
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const purple = rgb(0.545, 0.361, 0.965);
  const dark = rgb(0.04, 0.04, 0.06);
  const muted = rgb(0.45, 0.45, 0.5);
  const line = rgb(0.85, 0.85, 0.9);

  const pageW = 595, pageH = 842;
  const marginX = 50, marginY = 60;
  const maxW = pageW - 2 * marginX;
  const lineHeight = 13;

  let page = pdf.addPage([pageW, pageH]);
  let y = pageH - marginY;

  // Header
  page.drawText("PURAMA AI", { x: marginX, y, size: 10, font: helvBold, color: purple });
  page.drawText("Contrat de partenariat", { x: marginX, y: y - 13, size: 9, font: helv, color: muted });
  y -= 45;

  // Title
  for (const l of wrapText(title, helvBold, 16, maxW)) {
    page.drawText(l, { x: marginX, y, size: 16, font: helvBold, color: dark });
    y -= 20;
  }
  y -= 10;

  // Body
  const paragraphs = content.split(/\n\n+/);
  for (const para of paragraphs) {
    const lines = wrapText(para.replace(/\n/g, " "), helv, 10, maxW);
    for (const l of lines) {
      if (y < 200) {
        page = pdf.addPage([pageW, pageH]);
        y = pageH - marginY;
      }
      page.drawText(l, { x: marginX, y, size: 10, font: helv, color: dark });
      y -= lineHeight;
    }
    y -= 6;
  }

  // Signature blocks at the bottom of the LAST page (always force a new one for signatures)
  if (y < 220) {
    page = pdf.addPage([pageW, pageH]);
    y = pageH - marginY;
  }
  y -= 30;
  page.drawLine({ start: { x: marginX, y }, end: { x: pageW - marginX, y }, color: line, thickness: 0.6 });
  y -= 20;
  page.drawText("Signatures", { x: marginX, y, size: 12, font: helvBold, color: dark });
  y -= 25;

  // Left: Purama (pre-signed if image available)
  page.drawText("Pour Purama", { x: marginX, y, size: 9, font: helvBold, color: muted });
  page.drawText(meta.senderName, { x: marginX, y: y - 12, size: 10, font: helv, color: dark });
  page.drawText(meta.senderTitle, { x: marginX, y: y - 24, size: 8, font: helv, color: muted });

  if (meta.signatureImageBytes) {
    try {
      let img;
      // Try PNG first, then JPG
      try { img = await pdf.embedPng(meta.signatureImageBytes); }
      catch { img = await pdf.embedJpg(meta.signatureImageBytes); }
      const dims = img.scale(80 / Math.max(img.width, img.height));
      page.drawImage(img, {
        x: marginX,
        y: y - 60 - dims.height,
        width: dims.width,
        height: dims.height,
        opacity: 0.9,
      });
    } catch (e) { console.warn("[contract] signature embed failed", e); }
  }

  // Right: partner (DocuSeal will fill this in)
  const rightX = pageW / 2 + 20;
  page.drawText(`Pour ${meta.partnerName}`, { x: rightX, y, size: 9, font: helvBold, color: muted });
  page.drawText("(signature ci-dessous)", { x: rightX, y: y - 12, size: 8, font: helv, color: muted });
  page.drawRectangle({
    x: rightX,
    y: y - 100,
    width: 180,
    height: 70,
    borderColor: purple,
    borderWidth: 0.8,
    borderDashArray: [3, 3],
  });

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
