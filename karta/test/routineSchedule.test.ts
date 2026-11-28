import { describe, expect, it } from "vitest";
import { normalizeRoutineInput, normalizeRoutineTimestamp, RoutineValidationError, type RoutineInput } from "../src/routines/contracts.js";
import { calculateNextOccurrences, routineInstantFromLocal, routineMayDeliverAt } from "../src/routines/schedule.js";

const routine = (patch: Partial<RoutineInput> = {}): RoutineInput => ({
  name: "Bilan du matin", instruction: "Présente les résultats vérifiés et les décisions attendues.", enabled: true,
  schedule: { kind: "daily", time: "08:30", timezone: "Europe/Paris" }, channels: ["in_app", "call", "push"],
  deliveryMode: "parallel", agentTypes: ["legal"], length: "standard", quietHours: null, pausedUntil: null,
  onlyIfNew: true, maxCallMinutes: 2, monthlyCallMinutes: 60, ...patch,
});

describe("routine input as a shared, explicit contract", () => {
  it("normalizes text, timezone and dates without changing the source object", () => {
    const input = routine({ name: "  Mon bilan  ", pausedUntil: "2026-11-29T08:00:00+01:00",
      schedule: { kind: "weekly", time: "08:30", timezone: "Europe/Paris", days: [5, 1, 3] } });
    const before = structuredClone(input);
    const result = normalizeRoutineInput(input);
    expect(result).toMatchObject({ name: "Mon bilan", pausedUntil: "2026-11-29T07:00:00.000Z", schedule: { days: [1, 3, 5] } });
    result.channels.push("email"); expect(input).toEqual(before);
  });

  it.each([
    { extra: true }, { userId: "another-owner" }, { enabled: "true" }, { onlyIfNew: 1 },
    { channels: [] }, { channels: ["call", "call"] }, { channels: ["sms"] }, { name: "  " },
    { name: "bad\nname" }, { instruction: "unsafe\u0001control" }, { instruction: "x".repeat(4001) },
    { deliveryMode: "first" }, { length: "huge" }, { maxCallMinutes: 0 }, { maxCallMinutes: 11 },
    { maxCallMinutes: 1.5 }, { monthlyCallMinutes: 3001 }, { monthlyCallMinutes: 1 },
    { agentTypes: ["made-up-agent"] }, { agentTypes: ["legal", "legal"] },
    { quietHours: { start: "22:00", end: "22:00" } }, { quietHours: { start: "25:00", end: "08:00" } },
    { schedule: { kind: "daily", time: "08:30", timezone: "Europe/Paris", hidden: true } },
    { schedule: { kind: "daily", time: "8:30", timezone: "Europe/Paris" } },
    { schedule: { kind: "daily", time: "08:30", timezone: "+02:00" } },
    { schedule: { kind: "daily", time: "08:30", timezone: "Mars/Olympus" } },
    { schedule: { kind: "weekly", time: "08:30", timezone: "UTC", days: [1, 1] } },
    { schedule: { kind: "weekly", time: "08:30", timezone: "UTC", days: [7] } },
    { schedule: { kind: "event", event: "any", timezone: "UTC" } },
  ])("rejects an invalid or unknown setting before scheduling: %j", patch => {
    expect(() => normalizeRoutineInput({ ...routine(), ...patch })).toThrow(RoutineValidationError);
  });

  it.each(["2026-02-30T08:30:00Z", "2026-11-28T24:00:00Z", "2026-11-28T08:30:00", "2026-11-28T08:30:00+14:15", "2026-11-28T08:30:60Z"])("rejects impossible or unzoned timestamp %s", value => {
    expect(() => normalizeRoutineTimestamp(value)).toThrow(RoutineValidationError);
  });

  it("accepts real Unicode, multiline instructions and existing custom agents", () => {
    expect(normalizeRoutineInput(routine({ name: "Bilan 🗓️", instruction: "Première ligne.\nÉtat du projet 🧑🏽‍💻.",
      agentTypes: ["custom:84000000-0000-4000-8000-000000000001"] })).name).toBe("Bilan 🗓️");
  });
});

describe("local calendar, quiet hours and DST", () => {
  it("keeps the selected local hour in Paris rather than the host timezone", () => {
    expect(calculateNextOccurrences(routine(), "2026-11-28T06:00:00Z")).toEqual([
      "2026-11-28T07:30:00.000Z", "2026-11-29T07:30:00.000Z", "2026-11-30T07:30:00.000Z",
    ]);
  });
  it("selects the requested weekdays and keeps chronological order", () => {
    expect(calculateNextOccurrences(routine({ schedule: { kind: "weekly", days: [1, 5], time: "08:30", timezone: "Europe/Paris" } }),
      "2026-11-27T09:00:00Z")).toEqual(["2026-11-30T07:30:00.000Z", "2026-12-04T07:30:00.000Z", "2026-12-07T07:30:00.000Z"]);
  });
  it("shifts a spring gap to the first existing minute, not by an arbitrary hour", () => {
    expect(calculateNextOccurrences(routine({ schedule: { kind: "daily", time: "02:30", timezone: "Europe/Paris" } }),
      "2026-03-28T12:00:00Z", 2)).toEqual(["2026-03-29T01:00:00.000Z", "2026-03-30T00:30:00.000Z"]);
  });
  it("uses the first repeated autumn hour once and never catches up its second occurrence", () => {
    const input = routine({ schedule: { kind: "daily", time: "02:30", timezone: "Europe/Paris" } });
    expect(calculateNextOccurrences(input, "2026-10-24T12:00:00Z", 2)).toEqual(["2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"]);
    expect(calculateNextOccurrences(input, "2026-10-25T00:45:00Z", 1)).toEqual(["2026-10-26T01:30:00.000Z"]);
  });
  it("handles a thirty-minute DST gap in Lord Howe", () => {
    expect(calculateNextOccurrences(routine({ schedule: { kind: "daily", time: "02:15", timezone: "Australia/Lord_Howe" } }),
      "2026-10-03T12:00:00Z", 2)).toEqual(["2026-10-03T15:30:00.000Z", "2026-10-04T15:15:00.000Z"]);
  });
  it("supports a quarter-hour offset", () => {
    expect(calculateNextOccurrences(routine({ schedule: { kind: "daily", time: "08:30", timezone: "Asia/Kathmandu" } }),
      "2026-11-28T00:00:00Z", 1)).toEqual(["2026-11-28T02:45:00.000Z"]);
  });
  it("never produces an occurrence equal to or before the supplied cursor", () => {
    expect(calculateNextOccurrences(routine(), "2026-11-28T07:30:00Z", 1)).toEqual(["2026-11-29T07:30:00.000Z"]);
  });
  it("defers an evening slot through overnight quiet hours, including yesterday's slot", () => {
    const input = routine({ schedule: { kind: "daily", time: "23:00", timezone: "UTC" }, quietHours: { start: "22:00", end: "08:00" } });
    expect(calculateNextOccurrences(input, "2026-11-28T07:00:00Z", 2)).toEqual(["2026-11-28T08:00:00.000Z", "2026-11-29T08:00:00.000Z"]);
  });
  it("defers a daytime quiet slot to the allowed boundary", () => {
    expect(calculateNextOccurrences(routine({ schedule: { kind: "daily", time: "10:00", timezone: "UTC" }, quietHours: { start: "09:00", end: "12:00" } }),
      "2026-11-28T08:00:00Z", 1)).toEqual(["2026-11-28T12:00:00.000Z"]);
  });
  it("does not call an expired one-off or silently move one through a vacation pause", () => {
    const input = routine({ schedule: { kind: "once", at: "2026-11-28T08:30:00Z", timezone: "UTC" } });
    expect(calculateNextOccurrences(input, "2026-11-28T09:00:00Z")).toEqual([]);
    expect(calculateNextOccurrences({ ...input, pausedUntil: "2026-11-29T00:00:00Z" }, "2026-11-28T00:00:00Z")).toEqual([]);
  });
  it("keeps a one-off quiet-hours deferral visible until its real future instant", () => {
    expect(calculateNextOccurrences(routine({ schedule: { kind: "once", at: "2026-11-28T08:00:00Z", timezone: "UTC" },
      quietHours: { start: "22:00", end: "09:00" } }), "2026-11-28T08:30:00Z")).toEqual(["2026-11-28T09:00:00.000Z"]);
  });
  it("does not move backwards when quiet hours end inside the second folded hour", () => {
    expect(calculateNextOccurrences(routine({ schedule: { kind: "once", at: "2026-10-25T01:15:00Z", timezone: "Europe/Paris" },
      quietHours: { start: "01:30", end: "02:30" } }), "2026-10-24T00:00:00Z")).toEqual(["2026-10-25T01:30:00.000Z"]);
  });
  it("resumes regular slots after a pause without a backlog", () => {
    expect(calculateNextOccurrences(routine({ pausedUntil: "2026-12-20T12:00:00Z" }), "2026-11-28T00:00:00Z", 1))
      .toEqual(["2026-12-21T07:30:00.000Z"]);
  });
  it("returns no invented dates for disabled routines or event triggers", () => {
    expect(calculateNextOccurrences(routine({ enabled: false }), Date.now())).toEqual([]);
    expect(calculateNextOccurrences(routine({ schedule: { kind: "event", event: "blocked", timezone: "UTC" } }), Date.now())).toEqual([]);
  });
  it("checks current pause, disable and quiet boundaries for events as well", () => {
    const input = routine({ quietHours: { start: "22:00", end: "08:00" } });
    expect(routineMayDeliverAt(input, "2026-11-28T06:59:00Z")).toBe(false);
    expect(routineMayDeliverAt(input, "2026-11-28T07:00:00Z")).toBe(true);
    expect(routineMayDeliverAt({ ...input, enabled: false }, "2026-11-28T07:00:00Z")).toBe(false);
    expect(routineMayDeliverAt({ ...input, pausedUntil: "2026-11-28T08:00:00Z" }, "2026-11-28T07:00:00Z")).toBe(false);
  });
  it("interprets datetime-local fields in the selected zone with the same DST policy", () => {
    expect(routineInstantFromLocal("2026-11-28T08:30", "Europe/Paris")).toBe("2026-11-28T07:30:00.000Z");
    expect(routineInstantFromLocal("2026-03-29T02:30", "Europe/Paris")).toBe("2026-03-29T01:00:00.000Z");
    expect(routineInstantFromLocal("2026-10-25T02:30", "Europe/Paris")).toBe("2026-10-25T00:30:00.000Z");
    expect(() => routineInstantFromLocal("2026-02-30T08:30", "Europe/Paris")).toThrow();
  });
  it("bounds previews and rejects an invalid cursor", () => {
    expect(() => calculateNextOccurrences(routine(), "invalid")).toThrow();
    expect(() => calculateNextOccurrences(routine(), Date.now(), 10000)).toThrow();
    expect(() => calculateNextOccurrences(routine(), Date.now(), 0)).toThrow();
  });
});
