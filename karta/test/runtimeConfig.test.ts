import { expect, it } from "vitest";
import { validateRuntimeConfig } from "../src/runtime/config.js";

const valid = { supabaseUrl: "https://database.invalid", supabaseServiceRoleKey: "test-only",
  redisUrl: "redis://127.0.0.1:6379", port: 4100, adminToken: "test-admin",
  mockClaude: true, anthropicApiKey: "" };
it("accepts configured mock runtime and a configured live model", () => {
  expect(() => validateRuntimeConfig(valid)).not.toThrow();
  expect(() => validateRuntimeConfig({ ...valid, mockClaude: false, anthropicApiKey: "test-model" })).not.toThrow();
});
it.each([
  { supabaseServiceRoleKey: "" }, { adminToken: " " }, { mockClaude: false },
  { port: NaN }, { port: -1 }, { port: 65536 }, { port: 2.5 },
  { supabaseUrl: "file:///tmp/example" }, { supabaseUrl: "https://PRIVATE_SECRET@database.invalid" },
  { redisUrl: "https://PRIVATE_SECRET.invalid" },
])("rejects an incomplete runtime without leaking configuration: %j", change => {
  expect(() => validateRuntimeConfig({ ...valid, ...change })).toThrow("Configuration KARTA incomplète ou invalide");
});
