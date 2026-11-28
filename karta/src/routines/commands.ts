import { createHmac, timingSafeEqual } from "node:crypto";
import type { RoutineOccurrence } from "./store.js";

/** A short-lived call capability can capture an instruction, never execute it. */
export function phoneCommandToken(secret: string, occurrence: RoutineOccurrence, expiresAt: string): string {
  const expiry = Date.parse(expiresAt);
  if (secret.length < 32 || !Number.isFinite(expiry) || new Date(expiry).toISOString() !== expiresAt) throw new Error("Contexte téléphonique indisponible");
  return createHmac("sha256", secret).update(JSON.stringify([
    "iao-phone-capture-v1", occurrence.userId, occurrence.routineId, occurrence.id, expiresAt,
  ])).digest("hex");
}
export function verifyPhoneCommandToken(secret: string, occurrence: RoutineOccurrence, expiresAt: unknown, token: unknown, now = Date.now()): boolean {
  if (secret.length < 32 || typeof token !== "string" || !/^[0-9a-f]{64}$/i.test(token)
    || typeof expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt)) return false;
  const until = Date.parse(expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(until) || new Date(until).toISOString() !== expiresAt
    || until <= now || until > now + 15 * 60_000) return false;
  return timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(phoneCommandToken(secret, occurrence, expiresAt), "hex"));
}
