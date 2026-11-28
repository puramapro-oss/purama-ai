import { vi } from "vitest";
import type { Routine } from "../src/routines/contracts.js";
import { buildRoutineReport } from "../src/routines/report.js";
import type { RoutineRuntimeConfig } from "../src/routines/runtime.js";
import type { RoutineOccurrence, RoutineStore } from "../src/routines/store.js";

export const OWNER = "00000000-0000-4000-8000-000000000001";
export const ROUTINE = "00000000-0000-4000-8000-000000000002";
export const OCCURRENCE = "00000000-0000-4000-8000-000000000003";
export const CALL = "00000000-0000-4000-8000-000000000004";
export const REQUEST = "00000000-0000-4000-8000-000000000005";
export const NOW = Date.parse("2026-11-28T08:00:00.000Z");
export function routineFixture(): Routine {
  return { id: ROUTINE, userId: OWNER, revision: 1, createdAt: new Date(NOW - 86_400_000).toISOString(),
    updatedAt: new Date(NOW - 86_400_000).toISOString(), lastOccurrenceAt: null,
    config: { name: "Bilan du matin", instruction: "Résume mes résultats et les décisions en attente.", enabled: true,
      schedule: { kind: "daily", time: "09:00", timezone: "Europe/Paris" }, channels: ["in_app"],
      deliveryMode: "parallel", agentTypes: [], length: "express", quietHours: null, pausedUntil: null,
      onlyIfNew: false, maxCallMinutes: 2, monthlyCallMinutes: 30 } };
}
export function runFixture(index = 1, overrides: Record<string, unknown> = {}) {
  return { id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`, user_id: OWNER, agent_type: "email",
    status: "success", mode: "live", claude_mock: false, started_at: new Date(NOW - 50_000).toISOString(),
    finished_at: new Date(NOW - 10_000).toISOString(), result_summary: "Document préparé.", ...overrides };
}
export function occurrenceFixture(routine = routineFixture()): RoutineOccurrence {
  return { id: OCCURRENCE, userId: OWNER, routineId: routine.id, revision: 1, slot: `manual:${REQUEST}`,
    scheduledAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 30 * 60_000).toISOString(), status: "processing",
    report: buildRoutineReport(routine, [runFixture()], { since: new Date(NOW - 86_400_000).toISOString(),
      until: new Date(NOW).toISOString(), truncated: false }) };
}
export function runtimeFixture(): RoutineRuntimeConfig {
  return { enabled: true, pushEnabled: true, commandSecret: "test-only-command-secret-with-32-characters",
    phone: { enabled: true, apiKey: "test-only-api-key", agentId: CALL, webhookSecret: "test-only-signing-secret",
      webhookUrl: "https://example.invalid/routines/phone/webhook" } };
}
export function mockRoutineStore(overrides: Partial<RoutineStore> = {}): RoutineStore {
  return new Proxy(overrides as RoutineStore, { get(target, key) {
    if (key in target) return target[key as keyof RoutineStore];
    const fail = vi.fn(() => { throw new Error(`Unexpected store operation: ${String(key)}`); });
    Object.assign(target, { [key]: fail }); return fail;
  } });
}
