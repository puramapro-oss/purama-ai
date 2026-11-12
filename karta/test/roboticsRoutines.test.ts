import { describe, expect, it } from "vitest";
import { listRobotTargets } from "../src/robotics/catalog.js";
import { RobotSessionPreview } from "../src/robotics/preview.js";
import { parseRobotRoutine, parseRobotRoutineJson, prepareRobotRoutine, ROUTINE_FILE_MAX_BYTES, ROUTINE_FORMAT, serializeRobotRoutine } from "../src/robotics/routines.js";
import { planRobotSession } from "../src/robotics/session.js";

const NOW = 1_800_000_000_000;
const routine = () => ({
  format: ROUTINE_FORMAT, version: 1, name: "Accueil",
  steps: [
    { id: "speech", kind: "speech", text: "Bienvenue 🌍", durationMs: 1234 },
    { id: "gesture", kind: "gesture", gesture: "greeting", durationMs: 2000, required: false },
    { id: "pause", kind: "pause", durationMs: 1 },
  ],
});
const prepare = (input: unknown = routine(), now = NOW) => prepareRobotRoutine(input, { sessionId: "routine-test", targetId: "purama-simulator", now });

describe("Portable robot routines", () => {
  it("round-trips all supported intentions, Unicode and millisecond durations", () => {
    const parsed = parseRobotRoutine(routine());
    expect(parseRobotRoutineJson(serializeRobotRoutine(parsed))).toEqual(parsed);
    expect(parsed.steps[0]).toMatchObject({ durationMs: 1234, required: true });
    expect(parsed.steps[1].required).toBe(false);
  });
  it("stores no session identity, target or expiry and creates fresh requests", () => {
    expect(Object.keys(JSON.parse(serializeRobotRoutine(routine())))).toEqual(["format", "version", "name", "steps"]);
    const first = prepare();
    const later = prepare(routine(), NOW + 600_000);
    expect(later.expiresAt).toBe(first.expiresAt + 600_000);
    expect(planRobotSession(later, NOW + 600_000).status).toBe("simulation_ready");
  });
  it("does not mutate inputs or share mutable steps across requests", () => {
    const source = routine();
    const parsed = parseRobotRoutine(source);
    source.steps[0].durationMs = 60000;
    const first = prepare(parsed);
    first.steps[0].durationMs = 1;
    expect(parsed.steps[0].durationMs).toBe(1234);
    expect(prepare(parsed).steps[0].durationMs).toBe(1234);
  });
  it("accepts a UTF-8 BOM and trims the routine name", () => {
    expect(parseRobotRoutineJson(`\uFEFF${JSON.stringify({ ...routine(), name: "  Accueil  " })}`).name).toBe("Accueil");
  });
  it.each([null, [], "routine", 12, true, Object.create({ name: "inherited" })])("rejects a non-data root (%s)", input => {
    expect(() => parseRobotRoutine(input)).toThrow("objet JSON");
  });
  it.each([{}, { version: 2 }, { format: "robot.program" }, { name: "" }, { name: " " }, { name: "x".repeat(121) }])("rejects missing/unsupported format and invalid names (%s)", patch => {
    expect(() => parseRobotRoutine(Object.keys(patch).length ? { ...routine(), ...patch } : {})).toThrow();
  });
  it.each(["targetId", "sessionId", "expiresAt", "motorCommand", "url", "__proto__"])("rejects an embedded execution/unknown field (%s)", key => {
    expect(() => parseRobotRoutine({ ...routine(), [key]: "untrusted" })).toThrow("champ non autorisé");
  });
  it("rejects symbols and non-enumerable properties", () => {
    expect(() => parseRobotRoutine({ ...routine(), [Symbol("secret")]: true })).toThrow();
    const input = routine();
    Object.defineProperty(input, "name", { value: "hidden", enumerable: false });
    expect(() => parseRobotRoutine(input)).toThrow("données JSON");
  });
  it("never invokes root or step getters", () => {
    let reads = 0;
    const root = routine();
    Object.defineProperty(root, "steps", { enumerable: true, get: () => { reads++; return []; } });
    expect(() => parseRobotRoutine(root)).toThrow("données JSON");
    const input = routine();
    Object.defineProperty(input.steps[0], "text", { enumerable: true, get: () => { reads++; return "unsafe"; } });
    expect(() => parseRobotRoutine(input)).toThrow("données JSON");
    expect(reads).toBe(0);
  });
  it.each(["", "{", "null", "[]"])("rejects an invalid JSON file (%s)", text => {
    expect(() => parseRobotRoutineJson(text)).toThrow();
  });
  it("enforces a byte limit, including multibyte input, before parsing", () => {
    for (const text of [" ".repeat(ROUTINE_FILE_MAX_BYTES + 1), "é".repeat(ROUTINE_FILE_MAX_BYTES / 2 + 1)]) {
      expect(() => parseRobotRoutineJson(text)).toThrow("trop volumineux");
    }
  });
  it("can reimport the largest allowed text payload with escaped characters", () => {
    const input = { ...routine(), steps: Array.from({ length: 24 }, (_, index) => ({
      id: `step-${index}`, kind: "speech", text: "\u0000".repeat(2000), durationMs: 1,
    })) };
    const serialized = serializeRobotRoutine(input);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(ROUTINE_FILE_MAX_BYTES);
    expect(parseRobotRoutineJson(serialized).steps).toHaveLength(24);
  });
  it.each([0, 25])("rejects %s steps", count => {
    expect(() => parseRobotRoutine({ ...routine(), steps: Array.from({ length: count }, (_, index) => ({ id: `s${index}`, kind: "pause", durationMs: 1 })) })).toThrow("1 et 24");
  });
  it("rejects duplicate ids, unknown actions and sparse arrays", () => {
    const input = routine();
    expect(() => parseRobotRoutine({ ...input, steps: [input.steps[0], input.steps[0]] })).toThrow("dupliqués");
    expect(() => parseRobotRoutine({ ...input, steps: [{ id: "drive", kind: "move", durationMs: 10 }] })).toThrow("Action absente");
    expect(() => parseRobotRoutine({ ...input, steps: new Array(2) })).toThrow("sans trou");
  });
  it.each([0, -1, 0.5, 60_001, NaN, Infinity])("rejects an invalid step duration (%s)", durationMs => {
    expect(() => parseRobotRoutine({ ...routine(), steps: [{ id: "pause", kind: "pause", durationMs }] })).toThrow("hors limites");
  });
  it("enforces the cumulative five-minute limit", () => {
    const steps = Array.from({ length: 5 }, (_, index) => ({ id: `s${index}`, kind: "pause", durationMs: 60_000 }));
    expect(parseRobotRoutine({ ...routine(), steps }).steps).toHaveLength(5);
    expect(() => parseRobotRoutine({ ...routine(), steps: [...steps, { id: "extra", kind: "pause", durationMs: 1 }] })).toThrow("cinq minutes");
  });
  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER])("rejects an invalid generation clock (%s)", now => {
    expect(() => prepare(routine(), now)).toThrow();
  });
  it("keeps all physical targets blocked and cannot start them in the preview", () => {
    for (const target of listRobotTargets().filter(target => target.stage !== "simulator")) {
      const request = prepareRobotRoutine(routine(), { targetId: target.id, sessionId: "physical-test", now: NOW });
      expect(request.targetId).toBe(target.id);
      expect(planRobotSession(request, NOW)).toMatchObject({ status: "blocked", execution: "not_executed", hardwareControlAvailable: false });
      expect(() => new RobotSessionPreview().start(request, NOW)).toThrow("simulateur PURAMA");
    }
  });
});

describe("Reusable preview lifecycle", () => {
  it("clears a stopped preview and never resumes the old routine", () => {
    const preview = new RobotSessionPreview();
    preview.start(prepare(), NOW);
    preview.tick(NOW + 500);
    preview.stop();
    expect(preview.reset()).toEqual({ status: "idle", elapsedMs: 0, totalDurationMs: 0, activeStep: null, error: null, physicalActions: 0 });
    expect(preview.resume(NOW + 10_000).status).toBe("idle");
    expect(preview.tick(NOW + 20_000).status).toBe("idle");
  });
  it("refuses resetting a running or paused routine without stopping it", () => {
    const preview = new RobotSessionPreview();
    preview.start(prepare(), NOW);
    expect(() => preview.reset()).toThrow("Arrêtez la séance");
    preview.pause(NOW + 500);
    expect(() => preview.reset()).toThrow("Arrêtez la séance");
    expect(preview.snapshot()).toMatchObject({ status: "paused", elapsedMs: 500 });
  });
  it("clears an error before a new edit", () => {
    const preview = new RobotSessionPreview();
    preview.start(prepare(), NOW);
    preview.tick(NOW - 1);
    expect(preview.reset().error).toBeNull();
    expect(preview.start(prepare(), NOW).status).toBe("running");
  });
  it.each([300_000, 300_100])("completes a full five-minute routine on a normal or late tick (%s)", elapsed => {
    const input = { ...routine(), steps: Array.from({ length: 5 }, (_, index) => ({ id: `s${index}`, kind: "pause", durationMs: 60_000 })) };
    const preview = new RobotSessionPreview();
    preview.start(prepare(input), NOW);
    expect(preview.tick(NOW + elapsed)).toMatchObject({ status: "completed", elapsedMs: 300_000, physicalActions: 0 });
    expect(preview.reset().status).toBe("idle");
  });
  it("still expires when a pause pushes completion beyond the deadline", () => {
    const preview = new RobotSessionPreview();
    preview.start(prepare(), NOW);
    preview.pause(NOW + 500);
    preview.resume(NOW + 299_999);
    expect(preview.tick(NOW + 300_001)).toMatchObject({ status: "stopped", error: expect.stringContaining("expirée") });
  });
});
