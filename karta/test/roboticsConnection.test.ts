import { describe, expect, it } from "vitest";
import { listRobotTargets } from "../src/robotics/catalog.js";
import { getRobotConnectionGuide } from "../src/robotics/connectionGuide.js";
import { RobotSessionPreview } from "../src/robotics/preview.js";

const NOW = 1_800_000_000_000;
const session = () => ({
  version: 1, sessionId: "rehearsal", targetId: "purama-simulator", expiresAt: NOW + 60_000,
  steps: [
    { id: "voice", kind: "speech", text: "Bienvenue", durationMs: 1000 },
    { id: "gesture", kind: "gesture", gesture: "greeting", durationMs: 2000 },
    { id: "pause", kind: "pause", durationMs: 1000 },
  ],
});

describe("Connection guides", () => {
  it("couvre le catalogue sans inventer de robot raccordé", () => {
    for (const target of listRobotTargets()) {
      const guide = getRobotConnectionGuide(target.id);
      expect(guide.hardwareConnected).toBe(false);
      expect(guide.steps).toHaveLength(3);
      if (target.stage !== "simulator") {
        expect(guide.status).toBe("connector_required");
        expect(guide.capabilities.every(capability => capability.availability === "unavailable")).toBe(true);
      }
    }
  });
  it("ne confond pas aperçu, capteurs et locomotion", () => {
    const guide = getRobotConnectionGuide("purama-simulator");
    expect(guide.status).toBe("simulation_available");
    expect(guide.capabilities.filter(capability => capability.availability === "preview").map(capability => capability.name))
      .toEqual(["Parole", "Gestes nommés", "Pauses"]);
  });
  it("refuse les modèles inconnus et les noms du prototype", () => {
    for (const name of ["inconnu", "__proto__", "constructor", "toString"]) {
      expect(() => getRobotConnectionGuide(name)).toThrow("Modèle de robot inconnu");
    }
  });
  it("les résultats ne permettent pas de modifier le catalogue ou les instructions", () => {
    const first = getRobotConnectionGuide("pollen-reachy2");
    first.steps.length = 0;
    first.target.sources.length = 0;
    const next = getRobotConnectionGuide("pollen-reachy2");
    expect(next.steps).toHaveLength(3);
    expect(next.target.sources.length).toBeGreaterThan(0);
  });
});

describe("Rehearsal clock", () => {
  it("passe aux étapes suivantes à la bonne borne et termine sans action physique", () => {
    const preview = new RobotSessionPreview();
    expect(preview.start(session(), NOW).activeStep?.kind).toBe("speech");
    expect(preview.tick(NOW + 999).activeStep?.kind).toBe("speech");
    expect(preview.tick(NOW + 1000).activeStep?.kind).toBe("gesture");
    expect(preview.tick(NOW + 3000).activeStep?.kind).toBe("pause");
    expect(preview.tick(NOW + 5000)).toMatchObject({ status: "completed", elapsedMs: 4000, activeStep: null, physicalActions: 0 });
  });
  it("conserve exactement l'avancement pendant une pause, puis reprend", () => {
    const preview = new RobotSessionPreview();
    preview.start(session(), NOW);
    expect(preview.pause(NOW + 500).elapsedMs).toBe(500);
    expect(preview.tick(NOW + 5000)).toMatchObject({ status: "paused", elapsedMs: 500 });
    preview.resume(NOW + 6000);
    expect(preview.tick(NOW + 6500)).toMatchObject({ elapsedMs: 1000, activeStep: { kind: "gesture" } });
  });
  it("refuse de remplacer une séance active, y compris en pause", () => {
    const preview = new RobotSessionPreview();
    preview.start(session(), NOW);
    expect(() => preview.start(session(), NOW)).toThrow("Arrêtez la séance");
    preview.pause(NOW);
    expect(() => preview.start(session(), NOW)).toThrow("Arrêtez la séance");
    preview.stop();
    expect(preview.start(session(), NOW).status).toBe("running");
  });
  it("arrête immédiatement et ne reprend pas sur un tick tardif", () => {
    const preview = new RobotSessionPreview();
    preview.start(session(), NOW);
    preview.tick(NOW + 250);
    expect(preview.stop()).toMatchObject({ status: "stopped", elapsedMs: 250, activeStep: null });
    expect(preview.tick(NOW + 2000)).toMatchObject({ status: "stopped", elapsedMs: 250 });
    expect(preview.resume(NOW + 3000).status).toBe("stopped");
  });
  it("expire même pendant une pause et n'effectue pas de reprise automatique", () => {
    const preview = new RobotSessionPreview();
    preview.start(session(), NOW);
    preview.pause(NOW);
    expect(preview.resume(NOW + 60_000)).toMatchObject({ status: "stopped", error: expect.stringContaining("expirée") });
  });
  it.each([NaN, Infinity, NOW - 1])("arrête si l'horloge est invalide (%s)", now => {
    const preview = new RobotSessionPreview();
    preview.start(session(), NOW);
    expect(preview.tick(now)).toMatchObject({ status: "stopped", elapsedMs: 0, error: expect.stringContaining("Horloge") });
  });
  it("refuse chaque cible physique même avec une séance valide", () => {
    for (const target of listRobotTargets().filter(target => target.stage !== "simulator")) {
      expect(() => new RobotSessionPreview().start({ ...session(), targetId: target.id }, NOW)).toThrow("simulateur PURAMA");
    }
  });
  it("applique la validation commune aux durées et au texte", () => {
    const input = session();
    input.steps[0].durationMs = -1;
    expect(() => new RobotSessionPreview().start(input, NOW)).toThrow("hors limites");
    expect(() => new RobotSessionPreview().start({ ...session(), expiresAt: NOW }, NOW)).toThrow("expirer");
  });
  it("isole les données d'entrée et les snapshots de la séance active", () => {
    const input = session();
    const preview = new RobotSessionPreview();
    const snapshot = preview.start(input, NOW);
    input.steps[0].durationMs = 60000;
    if (snapshot.activeStep?.kind === "speech") snapshot.activeStep.text = "modifié";
    expect(preview.snapshot().activeStep).toMatchObject({ text: "Bienvenue", durationMs: 1000 });
    expect(preview.tick(NOW + 1000).activeStep?.kind).toBe("gesture");
  });
  it("une instance indépendante ne partage pas la séance", () => {
    const first = new RobotSessionPreview();
    first.start(session(), NOW);
    expect(new RobotSessionPreview().snapshot()).toMatchObject({ status: "idle", activeStep: null, totalDurationMs: 0 });
  });
});
