// Opt-in component check. It never runs an agent cycle or executes a business tool.
// Bundle with esbuild and keep @anthropic-ai/sdk external at its locked version.
import { strict as assert } from "node:assert";
import type { AnyToolDefinition } from "../../karta/src/engine/types.js";

async function main(): Promise<void> {
  if (process.env.PURAMA_LOCAL_SMOKE !== "1") throw new Error("Local smoke test not explicitly selected");
  const route = process.env.PURAMA_LOCAL_SMOKE_ROUTE ?? "direct";
  assert.ok(["direct", "omniroute"].includes(route), "Only inspected loopback routes may be selected");
  const metadataOrigin = "http://127.0.0.1:11434";
  const origin = route === "omniroute" ? "http://127.0.0.1:50128" : metadataOrigin;
  const model = process.env.PURAMA_LOCAL_SMOKE_MODEL ?? "devstral:24b";
  assert.ok(["devstral:24b", "qwen3-coder:30b"].includes(model), "Only inspected local models may be selected");
  const apiKey = route === "omniroute" ? process.env.PURAMA_LOCAL_SMOKE_API_KEY : "ollama";
  assert.ok(apiKey, "An isolated OmniRoute test API key is required for that route");
  delete process.env.PURAMA_LOCAL_SMOKE_API_KEY;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const usage: unknown[] = [];
  const results: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (resource, init) => {
    const url = new URL(resource instanceof Request ? resource.url : String(resource));
    const allowed = (url.origin === metadataOrigin && url.pathname === "/api/show")
      || (url.origin === origin && url.pathname === "/v1/messages");
    if (!allowed || url.search || url.username || url.password) {
      throw new Error("Local smoke test forbids this network destination");
    }
    if (url.pathname === "/v1/messages") calls += 1;
    const signal = init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000);
    const response = await originalFetch(resource, { ...init, signal, redirect: "error" });
    if (url.pathname === "/v1/messages") {
      try {
        const body = await response.clone().json() as { usage?: unknown };
        usage.push(body.usage ?? null);
      } catch { usage.push(null); }
    }
    return response;
  };
  try {
    const metadataResponse = await fetch(`${metadataOrigin}/api/show`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }),
    });
    assert.equal(metadataResponse.status, 200);
    const metadata = await metadataResponse.json() as {
      remote_host?: unknown; remote_model?: unknown;
      details?: { format?: string }; capabilities?: string[];
    };
    assert.ok(!metadata.remote_host && !metadata.remote_model, "Cloud model is forbidden for this check");
    assert.equal(metadata.details?.format, "gguf");
    assert.ok(metadata.capabilities?.includes("tools"));
    process.env.DOTENV_CONFIG_PATH = "/dev/null";
    process.env.ANTHROPIC_API_KEY = apiKey;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_BASE_URL = origin;
    process.env.ANTHROPIC_MODEL_FAST = route === "omniroute" ? `ollama/${model}` : model;
    process.env.ANTHROPIC_MODEL_MAIN = process.env.ANTHROPIC_MODEL_FAST;
    process.env.ANTHROPIC_LOG = "off";
    // Only this child process reads these settings; no .env or service changes.
    const { createRealClaudeClient } = await import("../../karta/src/claude/real.js");
    const client = createRealClaudeClient();
    const tool: AnyToolDefinition = {
      name: "record_fixture", description: "Préparer un résultat synthétique, sans effet réel.", sensitive: false,
      inputSchema: {
        type: "object", additionalProperties: false,
        properties: { name: { type: "string" }, amount: { type: "number" }, currency: { type: "string", enum: ["EUR"] } },
        required: ["name", "amount", "currency"],
      },
      execute: async () => { throw new Error("Business tool execution is forbidden in this test"); },
    };
    const fixture = { name: "Zoé", amount: 12.5, currency: "EUR" };
    // Preserve strict checks, but run independent cases even after one fails.
    // Otherwise a format failure would leave the tool contract unexamined.
    for (const testCase of [
      {
        name: "arithmetic_exact_format",
        input: {
          agentType: "local-smoke",
          systemPrompt: "Données synthétiques de test. Multiplie a par b et réponds uniquement par les chiffres du résultat.",
          context: { a: 6, b: 7 }, tools: [],
        },
        expectedSummary: "42", expectedTools: [],
      },
      {
        name: "structured_tool_decision",
        input: {
          agentType: "local-smoke",
          systemPrompt: "Données synthétiques. Utilise record_fixture exactement une fois pour recopier name, amount et currency. N'invente aucune valeur. Cela prépare uniquement un résultat de test, sans action réelle.",
          context: fixture, tools: [tool],
        },
        expectedSummary: undefined,
        expectedTools: [{ tool: "record_fixture", params: fixture }],
      },
    ]) {
      const started = performance.now();
      let observed: unknown;
      try {
        const decision = await client.decide(testCase.input);
        observed = { summary: decision.summary, toolCalls: decision.toolCalls };
        if (testCase.expectedSummary !== undefined) assert.equal(decision.summary.trim(), testCase.expectedSummary);
        assert.deepEqual(decision.toolCalls, testCase.expectedTools);
        results.push({ case: testCase.name, status: "PASS", elapsedMs: Math.round(performance.now() - started), observed });
      } catch (error) {
        results.push({ case: testCase.name, status: "FAILED", elapsedMs: Math.round(performance.now() - started), observed,
          error: error instanceof Error ? error.message : "Unknown local case error" });
      }
      console.log(JSON.stringify(results.at(-1)));
    }
    assert.equal(calls, 2);
    const status = results.every(result => result.status === "PASS") ? "PASS" : "FAILED";
    if (status === "FAILED") process.exitCode = 1;
    console.log(JSON.stringify({ status, model, route, calls, usage, results,
      scope: "real KARTA client and two synthetic decisions on the selected loopback route; not production or global quality" }));
  } catch (error) {
    console.error(JSON.stringify({ status: "FAILED", model, route, calls, usage, results,
      error: error instanceof Error ? error.message : "Unknown local smoke error" }));
    process.exitCode = 1;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main();
