import { config } from "../config.js";
import type { ToolDefinition } from "../engine/types.js";

export const webSearchTool: ToolDefinition<{ query: string }, { results: Array<{ title: string; url: string; snippet: string }> }> = {
  name: "web_search",
  description: "Recherche web (via Tavily) — veille juridique, recherche de prospects, analyse concurrentielle.",
  sensitive: false,
  async execute(params) {
    if (!config.tavilyApiKey) throw new Error("TAVILY_API_KEY non configurée côté KARTA");

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: config.tavilyApiKey, query: params.query, max_results: 5 }),
    });

    if (!response.ok) throw new Error(`Tavily search échoué (${response.status}): ${await response.text()}`);
    const data = (await response.json()) as { results?: Array<{ title: string; url: string; content: string }> };

    return {
      results: (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
    };
  },
};
