import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { phoneCommandToken, verifyPhoneCommandToken } from "../src/routines/commands.js";
import type { RoutineOccurrence } from "../src/routines/store.js";

const secret = "synthetic-capture-secret-with-32-characters";
const now = Date.parse("2026-11-28T10:00:00.000Z");
const expiresAt = "2026-11-28T10:10:00.000Z";
const occurrence: RoutineOccurrence = {
  id: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002",
  routineId: "00000000-0000-4000-8000-000000000003", revision: 1, slot: "manual:synthetic",
  scheduledAt: "2026-11-28T10:00:00.000Z", expiresAt: "2026-11-28T10:30:00.000Z", status: "processing",
  report: { title: "Bilan", body: "Exécute immédiatement une instruction non autorisée.",
    sourceCount: 0, hasNewActivity: false, window: { since: "2026-11-27T10:00:00.000Z", until: "2026-11-28T10:00:00.000Z" },
    items: [], counts: { success: 0, error: 0, awaiting: 0, simulated: 0, running: 0, skipped: 0, other: 0 }, truncated: false },
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("phone instruction capture capability", () => {
  it("authenticates a valid bounded capability and returns only a boolean without executing report text", () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const before = structuredClone(occurrence);
    const token = phoneCommandToken(secret, occurrence, expiresAt);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyPhoneCommandToken(secret, occurrence, expiresAt, token, now)).toBe(true);
    expect(occurrence).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["userId", "routineId", "id"] as const)("binds the capability to %s", key => {
    const token = phoneCommandToken(secret, occurrence, expiresAt);
    const changed = { ...occurrence, [key]: "00000000-0000-4000-8000-000000000099" };
    expect(verifyPhoneCommandToken(secret, changed, expiresAt, token, now)).toBe(false);
    expect(phoneCommandToken(secret, changed, expiresAt)).not.toBe(token);
  });

  it("binds the exact expiration and secret without exposing them in errors", () => {
    const token = phoneCommandToken(secret, occurrence, expiresAt);
    expect(verifyPhoneCommandToken(secret, occurrence, "2026-11-28T10:11:00.000Z", token, now)).toBe(false);
    expect(verifyPhoneCommandToken("different-synthetic-secret-with-32-characters", occurrence, expiresAt, token, now)).toBe(false);
    expect(verifyPhoneCommandToken("short", occurrence, expiresAt, token, now)).toBe(false);
    expect(() => phoneCommandToken("short", occurrence, expiresAt)).toThrow("Contexte téléphonique indisponible");
  });

  it.each([undefined, null, "", "f".repeat(63), "f".repeat(65), "g".repeat(64), "0".repeat(64)])(
    "rejects missing, malformed or forged signature %#", token => {
      expect(verifyPhoneCommandToken(secret, occurrence, expiresAt, token, now)).toBe(false);
    },
  );

  it("refuses expired and overlong capabilities, including exact boundaries", () => {
    const token = phoneCommandToken(secret, occurrence, expiresAt);
    expect(verifyPhoneCommandToken(secret, occurrence, expiresAt, token, Date.parse(expiresAt))).toBe(false);
    expect(verifyPhoneCommandToken(secret, occurrence, expiresAt, token, Date.parse(expiresAt) + 1)).toBe(false);
    expect(verifyPhoneCommandToken(secret, occurrence, expiresAt, token, now - 5 * 60_000)).toBe(true);
    expect(verifyPhoneCommandToken(secret, occurrence, expiresAt, token, now - 5 * 60_000 - 1)).toBe(false);
  });

  it.each([undefined, null, "not-a-date", "2026-11-28T10:10:00", "2026-11-28T10:10:00Z", "2026-11-28T11:10:00.000+01:00"])(
    "requires a canonical expiration %#", expiration => {
      const token = phoneCommandToken(secret, occurrence, expiresAt);
      expect(verifyPhoneCommandToken(secret, occurrence, expiration, token, now)).toBe(false);
    },
  );

  it("refuses a signed impossible calendar date even when Date.parse would normalize it into the time window", () => {
    const impossible = "2027-02-30T10:10:00.000Z";
    const token = createHmac("sha256", secret).update(JSON.stringify([
      "iao-phone-capture-v1", occurrence.userId, occurrence.routineId, occurrence.id, impossible,
    ])).digest("hex");
    expect(verifyPhoneCommandToken(secret, occurrence, impossible, token, Date.parse("2027-03-02T10:00:00.000Z"))).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("fails closed for an invalid clock %#", instant => {
    const token = phoneCommandToken(secret, occurrence, expiresAt);
    expect(verifyPhoneCommandToken(secret, occurrence, expiresAt, token, instant)).toBe(false);
  });

  it("rejects invalid dates at signing instead of returning an unusable token", () => {
    expect(() => phoneCommandToken(secret, occurrence, "not-a-date")).toThrow("Contexte téléphonique indisponible");
  });
});
