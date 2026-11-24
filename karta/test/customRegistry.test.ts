import { describe, expect, it } from "vitest";
import { CUSTOM_AGENT_TOOL_NAMES, CUSTOM_AGENT_TOOLS, resolveCustomAgentTools } from "../src/tools/customRegistry.js";

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

  it("résout chaque capacité une seule fois dans l'ordre initial, sans modifier l'entrée", () => {
    const names = ["web_search", "gmail_send", "web_search", "inconnu", "gmail_send", "knowledge_search"];
    Object.freeze(names);
    const tools = resolveCustomAgentTools(names);
    expect(tools.map(tool => tool.name)).toEqual(["web_search", "gmail_send", "knowledge_search"]);
    expect(tools[0]).toBe(CUSTOM_AGENT_TOOLS.web_search);
    expect(tools[1]).toBe(CUSTOM_AGENT_TOOLS.gmail_send);
    expect(tools[2]).toBe(CUSTOM_AGENT_TOOLS.knowledge_search);
    expect(names).toEqual(["web_search", "gmail_send", "web_search", "inconnu", "gmail_send", "knowledge_search"]);
  });

  it("conserve toutes les définitions et leurs contrôles, même lorsque le catalogue est répété", () => {
    const tools = resolveCustomAgentTools([...CUSTOM_AGENT_TOOL_NAMES, ...CUSTOM_AGENT_TOOL_NAMES]);
    expect(tools).toHaveLength(CUSTOM_AGENT_TOOL_NAMES.length);
    for (const [index, name] of CUSTOM_AGENT_TOOL_NAMES.entries()) {
      // Reference identity preserves schemas, handlers and security metadata.
      expect(tools[index]).toBe(CUSTOM_AGENT_TOOLS[name]);
    }
  });

  it("n'élargit pas la liste autorisée avec des noms hérités ou répétés", () => {
    expect(resolveCustomAgentTools(["constructor", "__proto__", "toString", "web_search", "constructor", "web_search"]))
      .toEqual([CUSTOM_AGENT_TOOLS.web_search]);
  });

  it("n'expose que des outils génériques, jamais les outils spécifiques à Purama (Stripe plateforme, Zernio, Apollo, DocuSeal, délégation)", () => {
    expect(CUSTOM_AGENT_TOOL_NAMES).not.toContain("stripe_list_unpaid_invoices");
    expect(CUSTOM_AGENT_TOOL_NAMES).not.toContain("zernio_publish");
    expect(CUSTOM_AGENT_TOOL_NAMES).not.toContain("apollo_search_people");
    expect(CUSTOM_AGENT_TOOL_NAMES).not.toContain("docuseal_create_submission");
    expect(CUSTOM_AGENT_TOOL_NAMES).not.toContain("delegate_to_agent");
  });
});
