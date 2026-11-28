import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import * as pdfLib from "pdf-lib";

const helperUrl = new URL("../../supabase/functions/partner-generate-contract/media-contract.ts", import.meta.url).href;
const handlerUrl = new URL("../../supabase/functions/partner-generate-contract/handler.ts", import.meta.url).href;
const { buildMediaPartnerContractText } = await import(/* @vite-ignore */ helperUrl);
const { createPartnerContractHandler } = await import(/* @vite-ignore */ handlerUrl);
type Row = Record<string, unknown>;
const user = "00000000-0000-4000-8000-000000000001";
const prospect = "00000000-0000-4000-8000-000000000011";
const contract = "00000000-0000-4000-8000-000000000021";
const version = "00000000-0000-4000-8000-000000000031";

// Execute the existing production PDF renderer with its locked, local dependency.
const renderer = { exports: {} as { renderContractPdf: (...args: unknown[]) => Promise<{
  bytes: Uint8Array; signatureArea: Row;
}> } };
new Function("require", "module", "exports", ts.transpileModule(readFileSync(
  new URL("../../supabase/functions/partner-generate-contract/pdf.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)((name: string) => {
  if (name !== "https://esm.sh/pdf-lib@1.17.1") throw new Error(`Unexpected PDF dependency ${name}`);
  return pdfLib;
}, renderer, renderer.exports);

function snapshot(overrides: Row = {}): Row {
  return {
    recipient_name: "Media Fixture", recipient_email: "recipient@example.invalid",
    sender_name: "Sender Fixture", sender_email: "sender@example.invalid", sender_title: "Responsable",
    company_name: "Entreprise Fixture", signature_name: "Sender Fixture", signature_title: "Responsable",
    signature_image_url: null,
    commission_first_payment: 30, commission_recurring: 30,
    outreach_profile: "media_affiliate", media_terms_version: "20261124",
    eligible_offer: { name: "Offre Fixture", url: "https://shop.example.invalid/fixture", summary: "Offre fictive de recette." },
    media_contract_terms: {
      parties_identity: "Les parties fictives sont Entreprise Fixture et Media Fixture, représentées dans ce dossier de test.",
      products_and_countries: "La seule offre admissible est Offre Fixture, dans les pays explicitement ouverts par cette convention fictive.",
      attribution: "Le code volontaire du partenaire détermine les ventes attribuées selon la politique jointe à cette fixture.",
      recurrence: "Les échéances admissibles sont celles de l'abonnement apporté, jusqu'à sa résiliation dans cette fixture.",
      payment: "Les relevés sont mensuels et les dates de règlement sont celles convenues dans la présente fixture.",
      refunds: "Un remboursement annule uniquement la commission associée à la ligne remboursée.",
      duration_termination: "Le partenariat de test prend fin à la date convenue ; les droits déjà acquis restent identifiés.",
      content_rights: "Le créateur conserve ses droits ; le repartage convenu est limité aux supports de cette fixture.",
      costs: "Chaque partie prend en charge les seuls frais qui lui sont explicitement attribués dans cette fixture.",
      disputes: "Les réclamations suivent le contact et la procédure expressément convenus entre les parties fictives.",
    }, ...overrides,
  };
}

function harness(context: Row, anthropicApiKey = "") {
  const calls: { url: string; init: RequestInit }[] = [];
  const rpcs: { name: string; args: Row }[] = [];
  const rendered: string[] = [];
  const pdfs = new Map<string, Uint8Array>();
  let current: Row = { contract_id: contract, status: "preparing", claimed: true,
    approval_version: version, snapshot: context };
  const handler = createPartnerContractHandler({
    authenticate: async (token: string) => token === "fixture-user" ? user : null,
    rpc: async (name: string, args: Row) => {
      rpcs.push({ name, args });
      if (name === "partner_contract_reserve") return { data: current, error: null };
      if (name === "partner_contract_save") {
        current = { ...current, claimed: false, status: "pending_approval", storage_path: args.p_storage_path,
          pdf_sha256: args.p_pdf_sha256, signature_area: args.p_signature_area };
        return { data: current, error: null };
      }
      if (name === "partner_contract_finish") return { data: { ...current, status: "failed" }, error: null };
      throw new Error(`Unexpected contract RPC ${name}`);
    },
    fetch: async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "https://api.anthropic.com/v1/messages") {
        return Response.json({ stop_reason: "end_turn", content: [{ text: "Projet historique fictif : paramètres conservés." }] });
      }
      const objectPrefix = "https://storage.example.invalid/storage/v1/object/partner-contracts/";
      const previewPrefix = "https://storage.example.invalid/storage/v1/object/sign/partner-contracts/";
      if (url.startsWith(objectPrefix) && init.method === "POST") {
        const path = url.slice(objectPrefix.length);
        if (pdfs.has(path)) throw new Error("Immutable PDF overwritten");
        pdfs.set(path, new Uint8Array(init.body as Uint8Array));
        return Response.json({ Key: path });
      }
      if (url.startsWith(previewPrefix) && init.method === "POST") {
        return Response.json({ signedURL: `/object/sign/partner-contracts/${url.slice(previewPrefix.length)}?token=fixture` });
      }
      throw new Error(`Unexpected provider request ${url}`);
    },
    renderPdf: async (title: string, content: string, meta: unknown) => {
      rendered.push(content);
      return renderer.exports.renderContractPdf(title, content, meta);
    },
    supabaseUrl: "https://storage.example.invalid", serviceKey: "fixture-not-a-secret",
    anthropicApiKey, docusealUrl: "https://signature.example.invalid", docusealKey: "",
  });
  return { calls, rpcs, rendered, pdfs, run: async (overrides: Row = {}) => {
    const response = await handler(new Request("https://example.invalid/contract", {
      method: "POST", headers: { Authorization: "Bearer fixture-user", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "prepare", prospect_id: prospect, ...overrides }),
    }));
    return { ...(await response.json()), http_status: response.status } as Row;
  } };
}

describe("explicit media contract", () => {
  it("renders the exact offer and complete operator terms with fixed commission rules", () => {
    const context = snapshot();
    const text = buildMediaPartnerContractText(context, "2026-11-24");
    expect(text).toContain("Offre concernée : Offre Fixture.");
    expect(text).toContain("https://shop.example.invalid/fixture");
    expect(text).toContain("premier paiement admissible est de 30 %");
    expect(text).toContain("récurrentes admissibles de l’abonnement apporté est également de 30 %");
    expect(text).toContain("avant déduction des frais du prestataire de paiement");
    expect(text).toContain("ne crée aucun droit automatique sur tous les achats futurs");
    expect(text).toContain("Aucune exclusivité");
    for (const value of Object.values(context.media_contract_terms as Row)) expect(text).toContain(value);
    expect(text).not.toContain("à compléter");
    expect(text).toContain("ne vaut ni accord ni signature");
  });

  it("prepares an immutable real PDF and exact preview without a model or signature request", async () => {
    const h = harness(snapshot());
    const result = await h.run({ outreach_profile: "legacy", commission_first_payment: 99 });
    expect(result).toMatchObject({ status: "pending_approval", http_status: 200, reused: false });
    expect(result.approval).toMatchObject({ commission_first_payment: 30, commission_recurring: 30,
      recipient_email: "recipient@example.invalid" });
    expect(h.calls.some(call => call.url.includes("anthropic") || call.url.includes("signature.example.invalid"))).toBe(false);
    expect(h.rendered).toHaveLength(1);
    expect(h.rendered[0]).toContain("Le partenaire reçoit 30 %");
    const [path, bytes] = [...h.pdfs][0];
    expect(path).toBe(`${user}/${contract}/${version}.pdf`);
    const save = h.rpcs.find(call => call.name === "partner_contract_save")!;
    expect(save.args.p_pdf_sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    const pdf = await pdfLib.PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    expect((save.args.p_signature_area as Row).page).toBe(pdf.getPageCount());
    expect(new Headers(h.calls.find(call => call.url.includes("/object/partner-contracts/"))?.init.headers).get("x-upsert")).toBe("false");
    expect((await h.run()).approval).toEqual(result.approval);
    expect(h.rendered).toHaveLength(1);
  });

  it("retains the legacy model path and its exact historical rates", async () => {
    const context = snapshot({ commission_first_payment: 9, commission_recurring: 3 });
    delete context.outreach_profile;
    delete context.media_terms_version;
    delete context.media_contract_terms;
    delete context.eligible_offer;
    const h = harness(context, "fixture-model-key");
    const result = await h.run();
    expect(result.approval).toMatchObject({ commission_first_payment: 9, commission_recurring: 3 });
    const modelCalls = h.calls.filter(call => call.url.includes("anthropic"));
    expect(modelCalls).toHaveLength(1);
    const body = JSON.parse(String(modelCalls[0].init.body));
    expect(JSON.parse(body.messages[0].content)).toMatchObject({ commission_first_payment: 9, commission_recurring: 3 });
    expect(h.rendered).toEqual(["Projet historique fictif : paramètres conservés."]);
  });

  it.each([
    ["outreach_profile", "editorial", "editorial_contract_not_applicable"],
    ["outreach_profile", "unrecognized", "contract_profile_invalid"],
    ["media_terms_version", "20261123", "media_contract_version_invalid"],
    ["commission_first_payment", 50, "media_contract_rate_mismatch"],
    ["commission_recurring", 10, "media_contract_rate_mismatch"],
    ["commission_first_payment", "30", "media_contract_rate_mismatch"],
    ["eligible_offer", { name: "Fixture", url: "http://example.invalid" }, "media_contract_offer_invalid"],
    ["eligible_offer", { name: "Fixture", url: "https://user:pass@example.invalid" }, "media_contract_offer_invalid"],
    ["eligible_offer", { name: "Fixture\nFake clause", url: "https://example.invalid" }, "media_contract_offer_invalid"],
    ["media_contract_terms", {}, "media_contract_terms_incomplete"],
    ["media_contract_terms", null, "media_contract_terms_incomplete"],
    ["sender_email", "invalid", "media_contract_identity_invalid"],
  ])("rejects invalid %s before any model, PDF, storage or signature effect (%s)", async (key, value, reason) => {
    const h = harness(snapshot({ [String(key)]: value }));
    const result = await h.run();
    expect(result).toMatchObject({ http_status: 200, status: "blocked", reason });
    expect(h.calls).toEqual([]);
    expect(h.rendered).toEqual([]);
    expect(h.rpcs.at(-1)).toMatchObject({ name: "partner_contract_finish", args: { p_outcome: "failed" } });
  });

  it.each(["parties_identity", "products_and_countries", "attribution", "recurrence", "payment", "refunds",
    "duration_termination", "content_rights", "costs", "disputes"])("requires the complete %s clause", key => {
    const context = snapshot();
    delete (context.media_contract_terms as Row)[key];
    expect(() => buildMediaPartnerContractText(context, "2026-11-24")).toThrow("media_contract_terms_incomplete");
  });

  it.each(["short", "long", "control", "unknown", "wrong_type"])("rejects a %s annex instead of inventing or omitting terms", kind => {
    const context = snapshot();
    const terms = context.media_contract_terms as Row;
    if (kind === "short") terms.costs = "court";
    else if (kind === "long") terms.costs = "x".repeat(2001);
    else if (kind === "control") terms.costs = "Texte de clause\u0000non imprimable";
    else if (kind === "unknown") terms.extra_obligation = "Une clause qui ne serait pas imprimée.";
    else terms.costs = ["Un texte mal typé"];
    expect(() => buildMediaPartnerContractText(context, "2026-11-24")).toThrow(
      kind === "short" || kind === "wrong_type" ? "media_contract_terms_incomplete" : "media_contract_terms_invalid");
  });

  it("preserves paragraph text exactly without passing it to a language model", () => {
    const context = snapshot();
    const clause = "Échéance A : 2027-02-10.\nÉchéance B : 2027-03-10.\nLe montant est calculé sur les ventes admises.";
    (context.media_contract_terms as Row).payment = clause;
    expect(buildMediaPartnerContractText(context, "2026-11-24")).toContain(`5. Relevés, facturation, devise et règlement\n${clause}`);
  });
});
