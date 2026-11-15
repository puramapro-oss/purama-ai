import { describe, expect, it, vi } from "vitest";

// Mock supabase pour éviter "supabaseKey is required" (les tools importés par customRegistry.ts
// dépendent de supabase, mais ce test ne l'utilise pas réellement)
vi.mock("../src/db/supabase.js", () => ({
  supabase: {},
}));

const { CUSTOM_AGENT_TOOL_NAMES, resolveCustomAgentTools } = await import("../src/tools/customRegistry.js");

describe("customRegistry — liste blanche des outils pour les agents créés par les users", () => {
  it("résout des noms d'outils connus", () => {
    const tools = resolveCustomAgentTools(["web_search", "send_notification"]);
    expect(tools.map((t) => t.name)).toEqual(["web_search", "send_notification"]);
  });

  it("ignore silencieusement les noms inconnus (défense en profondeur)", () => {
    const tools = resolveCustomAgentTools(["web_search", "outil_invente_par_claude", "gen_image"]);
    expect(tools.map((t) => t.name)).toEqual(["web_search"]);
  });

  it("retourne [] pour null/undefined/vide", () => {
    expect(resolveCustomAgentTools(null)).toEqual([]);
    expect(resolveCustomAgentTools(undefined)).toEqual([]);
    expect(resolveCustomAgentTools([])).toEqual([]);
  });

  it("n'expose que des outils génériques, jamais les outils spécifiques à Purama (Stripe plateforme, Zernio, Apollo, DocuSeal, délégation)", () => {
    expect(CUSTOM_AGENT_TOOL_NAMES).not.toContain("stripe_list_unpaid_invoices");
    expect(CUSTOM_AGENT_TOOL_NAMES).not.toContain("zernio_publish");
    expect(CUSTOM_AGENT_TOOL_NAMES).not.toContain("apollo_search_people");
    expect(CUSTOM_AGENT_TOOL_NAMES).not.toContain("docuseal_create_submission");
    expect(CUSTOM_AGENT_TOOL_NAMES).not.toContain("delegate_to_agent");
  });

  it("rejette silencieusement les non-strings (ex: [123, 'web_search'] → seul 'web_search' retenu)", () => {
    // @ts-ignore — on simule volontairement un payload malformé venant de Claude ou d'un mock
    const tools = resolveCustomAgentTools([123, "web_search", null, "send_notification", undefined, false]);
    expect(tools.map((t) => t.name)).toEqual(["web_search", "send_notification"]);
  });

  it("déduplique stablement les noms d'outils (garde le premier vu, ordre préservé)", () => {
    const tools = resolveCustomAgentTools(["web_search", "send_notification", "web_search", "web_search", "generate_pdf", "send_notification"]);
    expect(tools.map((t) => t.name)).toEqual(["web_search", "send_notification", "generate_pdf"]);
  });

  it("rejette les noms de la chaîne de prototype (constructor/__proto__/toString/hasOwnProperty/valueOf/toLocaleString/isPrototypeOf) — fuite de liste blanche vérifiée empiriquement avant ce correctif", () => {
    for (const poisoned of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "valueOf",
      "toLocaleString",
      "isPrototypeOf",
      "propertyIsEnumerable",
    ]) {
      expect(resolveCustomAgentTools([poisoned])).toEqual([]);
    }
  });

  it("un nom de prototype mélangé à des noms valides ne pollue pas le résultat", () => {
    const tools = resolveCustomAgentTools(["web_search", "constructor", "__proto__", "send_notification"]);
    expect(tools.map((t) => t.name)).toEqual(["web_search", "send_notification"]);
  });

  it("combine rejet non-strings + déduplication + whitelist stricte", () => {
    const tools = resolveCustomAgentTools([
      "web_search",
      123 as any,
      "outil_invente",
      "web_search",
      "send_notification",
      null as any,
      "web_search",
      "zernio_publish", // sensible, pas dans la whitelist
      "generate_pdf",
    ]);
    expect(tools.map((t) => t.name)).toEqual(["web_search", "send_notification", "generate_pdf"]);
  });
});
