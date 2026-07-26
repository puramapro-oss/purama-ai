import { describe, expect, it } from "vitest";
import { CUSTOM_AGENT_TOOL_NAMES, resolveCustomAgentTools } from "../src/tools/customRegistry.js";

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
});
