// Actual CLI child + real SDK and loopback HTTP. The server is synthetic;
// this suite verifies qualification gates, not a real model or model quality.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const model = "qualification-fixture";
const requests: Array<{ path: string; headers: Record<string, string | string[] | undefined> }> = [];
let origin: string;
let inventory: "ready" | "missing" | "no_tools" = "ready";
let answer: "correct" | "wrong_text" | "wrong_tool" = "correct";

const server = createServer(async (req, res) => {
  requests.push({ path: req.url!, headers: req.headers });
  let raw = "";
  for await (const chunk of req) raw += chunk;
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/v1/models") {
    res.end(JSON.stringify({ models: [{ type: "llm", format: "gguf",
      loaded_instances: inventory === "missing" ? [] : [{ id: model }],
      capabilities: { trained_for_tool_use: inventory !== "no_tools" },
    }] }));
    return;
  }
  const input = JSON.parse(raw) as { tools?: unknown[] };
  const usesTool = (input.tools?.length ?? 0) > 0;
  const content = usesTool
    ? [{ type: "tool_use", id: "tool_fixture", name: "prepare_fixture",
      input: { title: answer === "wrong_tool" ? "PRIVATE_QUALIFICATION_PROVIDER" : "Création à Frasne" } }]
    : [{ type: "text", text: answer === "wrong_text" ? "PRIVATE_QUALIFICATION_PROVIDER" : "42" }];
  res.end(JSON.stringify({ id: "msg_qualification_fixture", type: "message", role: "assistant", model,
    content, stop_reason: usesTool ? "tool_use" : "end_turn", stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 2 },
  }));
});

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
beforeEach(() => { requests.length = 0; inventory = "ready"; answer = "correct"; });

type Run = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
async function runSmoke(extra: Record<string, string> = {}): Promise<Run> {
  // A deliberate allowlist prevents these child processes from inheriting real
  // account credentials or accidentally reading project .env files.
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/qualify-lmstudio.ts"], {
    cwd, env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: "/dev/null",
      PURAMA_LMSTUDIO_SMOKE: "1", PURAMA_LMSTUDIO_MODEL: model,
      PURAMA_LMSTUDIO_URL: origin, PURAMA_LMSTUDIO_TOKEN: "qualification-local-fixture",
      ANTHROPIC_API_KEY: "qualification-cloud-fixture",
      ANTHROPIC_AUTH_TOKEN: "qualification-ambient-fixture",
      ANTHROPIC_BASE_URL: "https://qualification-cloud.invalid", ...extra,
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  return await new Promise<Run>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); }, 7_500);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
function records(run: Run) {
  return run.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as {
    case: string; status: string; receipt: { requestedModel: string; responseModel: string; inputTokens: number };
  });
}

describe("existing LM Studio qualification CLI gates", () => {
  it("verifies exact text and structured tool through the real CLI without leaking cloud credentials", async () => {
    const result = await runSmoke();
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(records(result)).toEqual([
      expect.objectContaining({ case: "exact_format", status: "PASS", receipt: expect.objectContaining({ requestedModel: model, responseModel: model, inputTokens: 12 }) }),
      expect.objectContaining({ case: "structured_tool", status: "PASS" }),
    ]);
    expect(requests.map(request => request.path)).toEqual(["/api/v1/models", "/v1/messages", "/api/v1/models", "/v1/messages"]);
    for (const request of requests) {
      expect(JSON.stringify(request.headers)).not.toContain("qualification-cloud-fixture");
      expect(JSON.stringify(request.headers)).not.toContain("qualification-ambient-fixture");
    }
    expect(requests[0].headers.authorization).toBe("Bearer qualification-local-fixture");
    expect(requests[1].headers["x-api-key"]).toBe("qualification-local-fixture");
    expect(requests[1].headers.authorization).toBeUndefined();
  });

  it.each([
    { KARTA_MODEL_PROFILES_JSON: "not-json" },
    { KARTA_ANTHROPIC_PROMPT_CACHE: "not-a-mode" },
  ] as Array<Record<string, string>>)("does not mistake unrelated ambient cloud configuration for local unavailability: %j", async extra => {
    const result = await runSmoke(extra);
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(records(result).map(record => record.status)).toEqual(["PASS", "PASS"]);
    expect(requests.map(request => request.path)).toEqual(["/api/v1/models", "/v1/messages", "/api/v1/models", "/v1/messages"]);
  });

  it.each([{ PURAMA_LMSTUDIO_SMOKE: "" }, { PURAMA_LMSTUDIO_MODEL: "" }] as Array<Record<string, string>>)(
    "refuses an unselected qualification or missing exact model before network I/O: %j", async extra => {
      const result = await runSmoke(extra);
      expect(result).toMatchObject({ code: 1, signal: null, stdout: "" });
      expect(result.stderr).toContain("BLOQUÉ");
      expect(requests).toEqual([]);
    },
  );

  it("does not qualify an unloaded model or submit either synthetic prompt", async () => {
    inventory = "missing";
    const result = await runSmoke();
    expect(result.code).toBe(1);
    expect(records(result).map(record => record.status)).toEqual(["NON VALIDE", "NON VALIDE"]);
    expect(requests.map(request => request.path)).toEqual(["/api/v1/models", "/api/v1/models"]);
  });

  it("reports the tool qualification as failed when loaded capabilities do not support tools", async () => {
    inventory = "no_tools";
    const result = await runSmoke();
    expect(result.code).toBe(1);
    expect(records(result).map(record => record.status)).toEqual(["PASS", "NON VALIDE"]);
    expect(requests.map(request => request.path)).toEqual(["/api/v1/models", "/v1/messages", "/api/v1/models"]);
  });

  it.each(["wrong_text", "wrong_tool"] as const)("rejects a semantically wrong %s result and omits the provider content", async value => {
    answer = value;
    const result = await runSmoke();
    expect(result.code).toBe(1);
    expect(records(result).map(record => record.status)).toEqual(value === "wrong_text" ? ["NON VALIDE", "PASS"] : ["PASS", "NON VALIDE"]);
    expect(records(result).every(record => record.receipt.inputTokens === 12)).toBe(true);
    expect(result.stdout + result.stderr).not.toContain("PRIVATE_QUALIFICATION_PROVIDER");
    expect(requests).toHaveLength(4);
  });
});
