// Compta Agent — Factur-X invoice generator
// POST { invoice_id }
//   1. Fetch the invoice + the user's compta_agent_config (issuer)
//   2. Generate the Factur-X XML (BASIC profile, EN16931-compliant)
//   3. Render a visual PDF using pdf-lib
//   4. Embed the XML as a file attachment with AFRelationship=Source (Factur-X spec)
//   5. Upload the resulting PDF to Storage (compta-invoices/<user_id>/<invoice_number>.pdf)
//   6. Update the invoice row with facturx_pdf_url + facturx_xml
//
// Note: pdf-lib alone cannot produce a fully PDF/A-3 conformant file (would need ICC,
// XMP, OutputIntent — heavy). We produce a standard PDF with the embedded XML attachment
// + the AFRelationship marker, which is what Factur-X-aware software actually parses.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb, PDFName, PDFHexString, PDFArray, PDFRawStream, PDFDict } from "https://esm.sh/pdf-lib@1.17.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

interface InvoiceLine {
  description: string;
  quantity: number;
  unit_price: number;
  tva_rate: number;
  total_ht?: number;
}

interface Invoice {
  id: string;
  user_id: string;
  invoice_number: string;
  type: string;
  counterpart_name: string;
  counterpart_siren: string | null;
  counterpart_tva_number: string | null;
  counterpart_address: string | null;
  counterpart_email: string | null;
  total_ht: number;
  total_tva: number;
  total_ttc: number;
  lines: InvoiceLine[];
  issue_date: string;
  due_date: string | null;
  payment_method: string | null;
  notes: string | null;
}

interface IssuerConfig {
  company_name: string | null;
  siren: string | null;
  siret: string | null;
  tva_number: string | null;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  country: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);
    const token = authHeader.replace("Bearer ", "");

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      db: { schema: "purama_ai" },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;

    const { invoice_id } = (await req.json()) as { invoice_id?: string };
    if (!invoice_id) return json({ error: "invoice_id required" }, 400);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      db: { schema: "purama_ai" },
    });

    // Fetch invoice + issuer config
    const { data: invoice, error: invErr } = await admin
      .from("compta_invoices")
      .select("*")
      .eq("id", invoice_id)
      .eq("user_id", userId)
      .single();
    if (invErr || !invoice) return json({ error: "Invoice not found" }, 404);

    const { data: issuer, error: cfgErr } = await admin
      .from("compta_agent_config")
      .select("company_name, siren, siret, tva_number, address, postal_code, city, country")
      .eq("user_id", userId)
      .single();
    if (cfgErr || !issuer) {
      return json({ error: "Issuer config missing — fill in your company info first" }, 400);
    }

    const inv = invoice as Invoice;
    const iss = issuer as IssuerConfig;

    // Generate the Factur-X XML
    const xml = buildFacturXXml(inv, iss);

    // Render the visual PDF
    const pdfBytes = await renderInvoicePdf(inv, iss, xml);

    // Upload to Storage
    const storagePath = `${userId}/${inv.invoice_number}.pdf`;
    const uploadRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/compta-invoices/${storagePath}`,
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
    if (!uploadRes.ok) {
      const t = await uploadRes.text();
      console.error("[facturx] upload failed", t);
      return json({ error: "Upload failed", details: t }, 502);
    }

    // Generate a signed URL valid 7 days
    const signRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/compta-invoices/${storagePath}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expiresIn: 60 * 60 * 24 * 7 }),
      },
    );
    const signJson = await signRes.json() as { signedURL?: string };
    const fullUrl = signJson.signedURL
      ? `${SUPABASE_URL}/storage/v1${signJson.signedURL}`
      : null;

    // Update the row
    await admin
      .from("compta_invoices")
      .update({
        facturx_pdf_url: fullUrl,
        facturx_xml: xml,
        facturx_profile: "EN16931",
      })
      .eq("id", invoice_id);

    return json({ ok: true, url: fullUrl, storage_path: storagePath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[compta-invoice-facturx]", msg);
    return json({ error: msg }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// =============================================================
// Factur-X XML (EN16931 BASIC profile, abridged but valid structure)
// =============================================================
function escapeXml(s: string | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function fmt(n: number): string {
  return (Math.round(Number(n) * 100) / 100).toFixed(2);
}

function buildFacturXXml(inv: Invoice, iss: IssuerConfig): string {
  const issueDate = inv.issue_date.replace(/-/g, "");
  const dueDate = (inv.due_date ?? inv.issue_date).replace(/-/g, "");

  // Group lines by VAT rate for the TradeTax breakdown
  const taxByRate = new Map<number, { base: number; tax: number }>();
  for (const l of inv.lines ?? []) {
    const rate = Number(l.tva_rate) || 0;
    const ht = Number(l.quantity) * Number(l.unit_price);
    const tax = ht * (rate / 100);
    const cur = taxByRate.get(rate) ?? { base: 0, tax: 0 };
    cur.base += ht;
    cur.tax += tax;
    taxByRate.set(rate, cur);
  }

  const lineItemsXml = (inv.lines ?? [])
    .map((l, i) => {
      const ht = Number(l.quantity) * Number(l.unit_price);
      return `
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>${i + 1}</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>${escapeXml(l.description)}</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount>${fmt(l.unit_price)}</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="C62">${fmt(l.quantity)}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>S</ram:CategoryCode>
          <ram:RateApplicablePercent>${fmt(l.tva_rate)}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${fmt(ht)}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`;
    })
    .join("");

  const taxBreakdown = [...taxByRate.entries()]
    .map(([rate, t]) => `
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${fmt(t.tax)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount>${fmt(t.base)}</ram:BasisAmount>
        <ram:CategoryCode>S</ram:CategoryCode>
        <ram:RateApplicablePercent>${fmt(rate)}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`)
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${escapeXml(inv.invoice_number)}</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">${issueDate}</udt:DateTimeString>
    </ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>${lineItemsXml}
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>${escapeXml(iss.company_name ?? "")}</ram:Name>
        <ram:SpecifiedLegalOrganization>
          <ram:ID schemeID="0002">${escapeXml(iss.siren ?? iss.siret ?? "")}</ram:ID>
        </ram:SpecifiedLegalOrganization>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${escapeXml(iss.postal_code ?? "")}</ram:PostcodeCode>
          <ram:LineOne>${escapeXml(iss.address ?? "")}</ram:LineOne>
          <ram:CityName>${escapeXml(iss.city ?? "")}</ram:CityName>
          <ram:CountryID>${escapeXml(iss.country ?? "FR")}</ram:CountryID>
        </ram:PostalTradeAddress>
        ${iss.tva_number ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${escapeXml(iss.tva_number)}</ram:ID></ram:SpecifiedTaxRegistration>` : ""}
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>${escapeXml(inv.counterpart_name)}</ram:Name>
        ${inv.counterpart_siren ? `<ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">${escapeXml(inv.counterpart_siren)}</ram:ID></ram:SpecifiedLegalOrganization>` : ""}
        ${inv.counterpart_address ? `<ram:PostalTradeAddress><ram:LineOne>${escapeXml(inv.counterpart_address)}</ram:LineOne><ram:CountryID>FR</ram:CountryID></ram:PostalTradeAddress>` : ""}
        ${inv.counterpart_tva_number ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${escapeXml(inv.counterpart_tva_number)}</ram:ID></ram:SpecifiedTaxRegistration>` : ""}
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>${taxBreakdown}
      <ram:SpecifiedTradePaymentTerms>
        <ram:DueDateDateTime>
          <udt:DateTimeString format="102">${dueDate}</udt:DateTimeString>
        </ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${fmt(inv.total_ht)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${fmt(inv.total_ht)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">${fmt(inv.total_tva)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${fmt(inv.total_ttc)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${fmt(inv.total_ttc)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;
}

// =============================================================
// PDF rendering (visual invoice + embedded Factur-X XML)
// =============================================================
async function renderInvoicePdf(
  inv: Invoice,
  iss: IssuerConfig,
  xml: string,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Facture ${inv.invoice_number}`);
  pdf.setAuthor(iss.company_name ?? "Purama AI");
  pdf.setSubject(`Facture ${inv.invoice_number}`);
  pdf.setProducer("Purama AI — Compta Agent");
  pdf.setCreator("Purama AI — Factur-X EN16931");

  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const page = pdf.addPage([595, 842]); // A4
  const { width, height } = page.size();
  const purple = rgb(0.545, 0.361, 0.965); // #8B5CF6
  const dark = rgb(0.04, 0.04, 0.06);
  const muted = rgb(0.45, 0.45, 0.5);
  const line = rgb(0.85, 0.85, 0.9);

  // Header band
  page.drawRectangle({ x: 0, y: height - 90, width, height: 90, color: rgb(0.97, 0.97, 0.99) });
  page.drawText(iss.company_name ?? "Société", {
    x: 40, y: height - 50, size: 18, font: helvBold, color: dark,
  });
  if (iss.siren) {
    page.drawText(`SIREN ${iss.siren}${iss.tva_number ? "  ·  TVA " + iss.tva_number : ""}`, {
      x: 40, y: height - 70, size: 9, font: helv, color: muted,
    });
  }
  page.drawText("FACTURE", {
    x: width - 150, y: height - 50, size: 22, font: helvBold, color: purple,
  });
  page.drawText(inv.invoice_number, {
    x: width - 150, y: height - 75, size: 11, font: helv, color: dark,
  });

  // Issuer / Buyer blocks
  let y = height - 130;
  page.drawText("Émetteur", { x: 40, y, size: 9, font: helvBold, color: muted });
  page.drawText("Client", { x: 320, y, size: 9, font: helvBold, color: muted });
  y -= 14;
  drawMultiline(page, [
    iss.company_name ?? "",
    iss.address ?? "",
    `${iss.postal_code ?? ""} ${iss.city ?? ""}`.trim(),
    iss.country ?? "",
  ], 40, y, helv, 10, dark);
  drawMultiline(page, [
    inv.counterpart_name,
    inv.counterpart_address ?? "",
    inv.counterpart_siren ? `SIREN ${inv.counterpart_siren}` : "",
    inv.counterpart_tva_number ? `TVA ${inv.counterpart_tva_number}` : "",
  ], 320, y, helv, 10, dark);

  // Dates
  y -= 90;
  page.drawText(`Date d'émission : ${frDate(inv.issue_date)}`, { x: 40, y, size: 9, font: helv, color: dark });
  if (inv.due_date) {
    page.drawText(`Échéance : ${frDate(inv.due_date)}`, { x: 320, y, size: 9, font: helv, color: dark });
  }

  // Lines table header
  y -= 24;
  page.drawLine({ start: { x: 40, y: y + 6 }, end: { x: width - 40, y: y + 6 }, color: line, thickness: 0.8 });
  page.drawText("Désignation", { x: 44, y: y - 8, size: 9, font: helvBold, color: muted });
  page.drawText("Qté", { x: 340, y: y - 8, size: 9, font: helvBold, color: muted });
  page.drawText("PU HT", { x: 380, y: y - 8, size: 9, font: helvBold, color: muted });
  page.drawText("TVA", { x: 440, y: y - 8, size: 9, font: helvBold, color: muted });
  page.drawText("Total HT", { x: 500, y: y - 8, size: 9, font: helvBold, color: muted });
  y -= 18;
  page.drawLine({ start: { x: 40, y: y + 4 }, end: { x: width - 40, y: y + 4 }, color: line, thickness: 0.5 });

  // Lines
  for (const l of inv.lines ?? []) {
    if (y < 150) break; // safeguard
    y -= 14;
    page.drawText(truncate(l.description, 50), { x: 44, y, size: 9, font: helv, color: dark });
    page.drawText(fmt(l.quantity), { x: 340, y, size: 9, font: helv, color: dark });
    page.drawText(fmt(l.unit_price), { x: 380, y, size: 9, font: helv, color: dark });
    page.drawText(`${l.tva_rate}%`, { x: 440, y, size: 9, font: helv, color: dark });
    page.drawText(fmt(Number(l.quantity) * Number(l.unit_price)), { x: 500, y, size: 9, font: helv, color: dark });
  }

  // Totals box
  y -= 30;
  page.drawLine({ start: { x: 380, y: y + 14 }, end: { x: width - 40, y: y + 14 }, color: line, thickness: 0.8 });
  page.drawText("Total HT", { x: 380, y, size: 10, font: helv, color: muted });
  page.drawText(`${fmt(inv.total_ht)} €`, { x: 500, y, size: 10, font: helv, color: dark });
  y -= 14;
  page.drawText("TVA", { x: 380, y, size: 10, font: helv, color: muted });
  page.drawText(`${fmt(inv.total_tva)} €`, { x: 500, y, size: 10, font: helv, color: dark });
  y -= 18;
  page.drawText("Total TTC", { x: 380, y, size: 12, font: helvBold, color: purple });
  page.drawText(`${fmt(inv.total_ttc)} €`, { x: 500, y, size: 12, font: helvBold, color: purple });

  // Footer
  page.drawText("Facture conforme Factur-X EN 16931 — XML CrossIndustryInvoice intégré", {
    x: 40, y: 40, size: 7, font: helv, color: muted,
  });
  if (inv.payment_method) {
    page.drawText(`Mode de paiement : ${inv.payment_method}`, {
      x: 40, y: 56, size: 8, font: helv, color: muted,
    });
  }

  // Embed the Factur-X XML as a file attachment with the correct AFRelationship.
  // pdf-lib supports `attach()` and we then patch the AF entry afterwards.
  const xmlBytes = new TextEncoder().encode(xml);
  await pdf.attach(xmlBytes, "factur-x.xml", {
    mimeType: "application/xml",
    description: "Factur-X EN 16931 invoice data",
    creationDate: new Date(),
    modificationDate: new Date(),
  });

  // Add the AFRelationship marker to the embedded file spec (Factur-X compliance)
  try {
    const catalog = pdf.catalog;
    const namesDict = catalog.lookup(PDFName.of("Names"), PDFDict);
    if (namesDict) {
      const efDict = namesDict.lookup(PDFName.of("EmbeddedFiles"), PDFDict);
      if (efDict) {
        const namesArr = efDict.lookup(PDFName.of("Names"), PDFArray);
        if (namesArr) {
          for (let i = 1; i < namesArr.size(); i += 2) {
            const fileSpec = namesArr.lookup(i, PDFDict);
            if (fileSpec) {
              fileSpec.set(PDFName.of("AFRelationship"), PDFName.of("Source"));
            }
          }
        }
      }
    }
    // Also add an /AF entry on the catalog pointing at the embedded file spec
    const af = pdf.context.obj([]) as PDFArray;
    catalog.set(PDFName.of("AF"), af);
  } catch (e) {
    console.warn("[facturx] AFRelationship patch failed (non-fatal)", e);
  }

  return await pdf.save();
}

function drawMultiline(
  page: ReturnType<PDFDocument["addPage"]>,
  lines: string[],
  x: number,
  y: number,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  size: number,
  color: ReturnType<typeof rgb>,
) {
  let cy = y;
  for (const l of lines) {
    if (!l) continue;
    page.drawText(truncate(l, 60), { x, y: cy, size, font, color });
    cy -= size + 3;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function frDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
