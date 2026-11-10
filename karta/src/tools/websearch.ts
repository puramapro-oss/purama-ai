import { config } from "../config.js";
import type { ToolDefinition } from "../engine/types.js";

const MAX_RESULTS = 5;
const MAX_RESPONSE_BYTES = 1_048_576;
const SEARCH_TIMEOUT_MS = 30_000;
type SearchResult = { title: string; url: string; snippet: string };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Preserve the existing projection; optional Tavily fields are not execution authority.
 * Contract: https://docs.tavily.com/documentation/api-reference/endpoint/search
 */
function searchResults(value: unknown): SearchResult[] {
  if (!record(value) || !Array.isArray(value.results) || value.results.length > MAX_RESULTS) {
    throw new Error("Invalid search response");
  }
  return value.results.map((item: unknown) => {
    if (!record(item) || typeof item.title !== "string" || item.title.length > 4_096
      || typeof item.content !== "string" || item.content.length > 100_000
      || typeof item.url !== "string" || item.url.length === 0 || item.url.length > 8_192
      || item.url !== item.url.trim() || /[\u0000-\u001f\u007f]/.test(item.url)) {
      throw new Error("Invalid search result");
    }
    const url = new URL(item.url);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      throw new Error("Invalid source URL");
    }
    return { title: item.title, url: item.url, snippet: item.content };
  });
}

async function readSearchResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  if (!response.body) throw new Error("Missing search response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Search response too large");
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export const webSearchTool: ToolDefinition<{ query: string }, { results: SearchResult[] }> = {
  name: "web_search",
  description: "Recherche web (via Tavily) — veille juridique, recherche de prospects, analyse concurrentielle.",
  sensitive: false,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 2000 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(params) {
    if (!config.tavilyApiKey) throw new Error("TAVILY_API_KEY non configurée côté KARTA");

    // Same deadline/AbortController pattern as web-access-plan: no retries or
    // new execution framework. The deadline includes reading the response body.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Search deadline exceeded"));
      }, SEARCH_TIMEOUT_MS);
    });
    const request = async () => {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.tavilyApiKey}` },
        body: JSON.stringify({ query: params.query, max_results: MAX_RESULTS }),
      });
      if (controller.signal.aborted || !response.ok) {
        await response.body?.cancel();
        throw new Error("Search request not confirmed");
      }
      const data = await readSearchResponse(response, controller.signal);
      controller.signal.throwIfAborted();
      return { results: searchResults(data) };
    };
    try {
      return await Promise.race([request(), deadline]);
    } catch {
      // Transport, JSON and provider errors can contain credentials or private
      // request details. Never echo their bodies, messages or causes.
      throw new Error("Recherche Tavily indisponible : réponse invalide ou délai dépassé.");
    } finally {
      clearTimeout(timer);
    }
  },
};
