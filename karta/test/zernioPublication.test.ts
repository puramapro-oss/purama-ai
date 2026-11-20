import { beforeEach, expect, it, vi } from "vitest";
import { zernioPublishTool } from "../src/tools/zernio.js";
import type { ToolExecutionContext } from "../src/engine/types.js";

const h = vi.hoisted(() => ({ config: { zernioApiKey: "test-only", zernioBaseUrl: "" } }));
vi.mock("../src/config.js", () => ({ config: h.config }));
const send = vi.fn<typeof fetch>();
const input = { title: "Fixture", content: "Test local" };
const approved: ToolExecutionContext = { userId: "user", agentType: "legal", mode: "live", operationId: "approval-1", approvedActionId: "approval-1" };

beforeEach(() => {
  send.mockReset();
  vi.stubGlobal("fetch", send);
  h.config.zernioBaseUrl = "https://adapter.example.invalid/v1/";
  h.config.zernioApiKey = "test-only";
});

it("requires a claimed human approval for this exact operation", async () => {
  expect(zernioPublishTool.sensitive).toBe(true);
  expect(zernioPublishTool.requiresExplicitApproval).toBe(true);
  for (const context of [{ ...approved, approvedActionId: undefined }, { ...approved, operationId: "other" }, { ...approved, mode: "simulation" as const }]) {
    await expect(zernioPublishTool.execute(input, context)).rejects.toThrow(/approbation/i);
  }
  expect(send).not.toHaveBeenCalled();
});

it.each(["", "not a URL", "https:adapter.example.invalid", "http://adapter.example.invalid/v1",
  "https://user@adapter.example.invalid", "https://adapter.example.invalid/v1?x=1", "https://adapter.example.invalid/v1#part",
  "https://zernio.com/api/v1", "https://API.ZERNIO.COM.:443/api/v1"])("rejects an unconfigured or unsupported destination %j", async base => {
  h.config.zernioBaseUrl = base;
  await expect(zernioPublishTool.execute(input, approved)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});

it("uses only the chosen adapter and returns its acknowledged publication ID", async () => {
  send.mockResolvedValue(Response.json({ id: "fixture-id" }));
  await expect(zernioPublishTool.execute(input, approved)).resolves.toEqual({ publicationId: "fixture-id" });
  expect(send).toHaveBeenCalledOnce();
  const [target, options] = send.mock.calls[0]!;
  expect(String(target)).toBe("https://adapter.example.invalid/v1/publish");
  expect(options).toMatchObject({ method: "POST", redirect: "error", body: JSON.stringify(input) });
  expect(options?.signal).toBeInstanceOf(AbortSignal);
});

it.each([{ id: "" }, {}, { id: "would-look-successful", error: "refused" }])("rejects an unconfirmed adapter result", async response => {
  send.mockResolvedValue(Response.json(response));
  await expect(zernioPublishTool.execute(input, approved)).rejects.toThrow(/confirmation/i);
  expect(send).toHaveBeenCalledOnce();
});
