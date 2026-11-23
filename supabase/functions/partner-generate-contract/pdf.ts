import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

export async function renderContractPdf(
  title: string,
  content: string,
  meta: {
    senderName: string;
    senderTitle: string;
    partnerName: string;
    signatureImageBytes: Uint8Array | null;
  },
): Promise<{ bytes: Uint8Array; signatureArea: { x: number; y: number; w: number; h: number; page: number } }> {
  title = winAnsiText(title);
  content = winAnsiText(content);
  meta = { ...meta, senderName: winAnsiText(meta.senderName), senderTitle: winAnsiText(meta.senderTitle), partnerName: winAnsiText(meta.partnerName) };
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
  // These labels occupy fixed columns beside the exact signing rectangle.
  // Never silently clip an identity in the document presented for approval.
  const signatureColumnWidth = pageW / 2 - marginX - 20;
  for (const [label, font, size] of [
    [meta.senderName, helv, 10], [meta.senderTitle, helv, 8],
    [`Pour ${meta.partnerName}`, helvBold, 9],
  ] as const) {
    if (font.widthOfTextAtSize(label, size) > signatureColumnWidth) throw new Error("signature_identity_too_wide");
  }

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

  // Signature geometry comes from the actual final page and drawn rectangle.
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
    } catch { throw new Error("signature_image_invalid"); }
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

  return { bytes: await pdf.save(), signatureArea: {
    // POST /templates/pdf takes absolute coordinates and a page number starting
    // at 1. Do not reuse the normalized, zero-based geometry in API responses.
    x: rightX, y: pageH - (y - 100) - 70,
    w: 180, h: 70, page: pdf.getPageCount(),
  } };
}

function wrapText(text: string, font: Awaited<ReturnType<PDFDocument["embedFont"]>>, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (font.widthOfTextAtSize(w, size) > maxWidth) throw new Error("contract_word_too_wide");
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

function winAnsiText(value: string): string {
  // Keep meaningful French text. Unsupported scripts fail before any approval/send,
  // rather than silently dropping or inventing characters in a legal document.
  return value.normalize("NFC").replace(/[\u202f\u00a0]/g, " ").replace(/[\u200b\ufeff]/g, "");
}
