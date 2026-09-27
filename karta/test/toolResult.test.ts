import { describe, expect, it } from "vitest";
import { assertToolResult } from "../src/engine/tool-result.js";

describe("assertToolResult", () => {
  it.each([false, { ok: false }, { ok: undefined }, { success: false }, { success: "yes" }, { error: "failed" }])(
    "rejette les enveloppes ambiguës ou explicitement en échec: %j",
    (value) => expect(() => assertToolResult(value)).toThrow(/échec/)
  );

  it.each([undefined, null, true, "ok", [], { ok: true }, { success: true }, { error: null }, { error: false }, { error: "" }])(
    "accepte un résultat sans signal d'échec: %j",
    (value) => expect(() => assertToolResult(value)).not.toThrow()
  );
});
