import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getSocialCallbackGate,
  verifySocialCallbackSecret,
} from "./social-callback-gate.ts";

const STRONG_SECRET = "s".repeat(32);

describe("social callback gate", () => {
  it("is disabled by default", () => {
    assert.deepEqual(getSocialCallbackGate(undefined, STRONG_SECRET), {
      enabled: false,
      reason: "disabled",
    });
  });

  it("rejects truthy values other than the explicit true string", () => {
    assert.equal(getSocialCallbackGate("TRUE", STRONG_SECRET).enabled, false);
    assert.equal(getSocialCallbackGate("1", STRONG_SECRET).enabled, false);
  });

  it("rejects missing and short secrets", () => {
    assert.deepEqual(getSocialCallbackGate("true", undefined), {
      enabled: false,
      reason: "invalid_secret",
    });
    assert.equal(getSocialCallbackGate("true", "short").enabled, false);
  });

  it("opens only with the explicit flag and a strong secret", () => {
    assert.deepEqual(getSocialCallbackGate("true", STRONG_SECRET), {
      enabled: true,
      secret: STRONG_SECRET,
    });
  });

  it("accepts only the exact callback secret", async () => {
    assert.equal(await verifySocialCallbackSecret(STRONG_SECRET, STRONG_SECRET), true);
    assert.equal(await verifySocialCallbackSecret(`${STRONG_SECRET}x`, STRONG_SECRET), false);
    assert.equal(await verifySocialCallbackSecret(null, STRONG_SECRET), false);
  });
});
