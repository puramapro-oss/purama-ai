import { describe, expect, it } from "vitest";
import { hashChefBrief, normalizeChefBrief, validateChefBrief, type ChefBrief } from "../src/chef/brief.js";

function base(): ChefBrief {
  return {
    briefId: "feature-x",
    version: 1,
    goal: "Construire X complètement",
    repo: "puramapro-oss/example",
    requirements: [
      { key: "R2", description: "Deuxième" },
      { key: "R1", description: "Première", critical: true },
    ],
    tasks: [
      {
        key: "T2",
        title: "Intégrer",
        instructions: "Intégrer et vérifier.",
        dependsOn: ["T1"],
        requirementKeys: ["R2"],
        provider: "claude",
      },
      {
        key: "T1",
        title: "Coder",
        instructions: "Coder et tester.",
        requirementKeys: ["R1"],
        provider: "codex",
        scopeKey: "src/x",
      },
    ],
  };
}

describe("canonical CHEF briefs", () => {
  it("produit le même hash malgré un ordre superficiel différent", () => {
    const a = base();
    const b = base();
    b.requirements.reverse();
    b.tasks.reverse();
    expect(hashChefBrief(a)).toBe(hashChefBrief(b));
  });

  it("change le hash si une exigence change réellement", () => {
    const a = base();
    const b = base();
    b.requirements[0].description = "Exigence modifiée";
    expect(hashChefBrief(a)).not.toBe(hashChefBrief(b));
  });

  it("normalise les valeurs par défaut de façon déterministe", () => {
    const normalized = normalizeChefBrief(base());
    expect(normalized.requirements.map(r => r.key)).toEqual(["R1", "R2"]);
    expect(normalized.tasks.map(t => t.key)).toEqual(["T1", "T2"]);
    expect(normalized.tasks[0]).toMatchObject({ provider: "codex", accessMode: "write", priority: 0, maxAttempts: 3 });
  });

  it("refuse les requirements oubliées par le plan", () => {
    const value = base();
    value.tasks = value.tasks.filter(t => t.key === "T1");
    expect(() => validateChefBrief(value)).toThrow(/sans tâche/);
  });

  it("refuse une dépendance inconnue", () => {
    const value = base();
    value.tasks[1].dependsOn = ["MISSING"];
    expect(() => validateChefBrief(value)).toThrow(/Dépendance inconnue/);
  });

  it("refuse les cycles de dépendances", () => {
    const value = base();
    value.tasks.find(t => t.key === "T1")!.dependsOn = ["T2"];
    expect(() => validateChefBrief(value)).toThrow(/Cycle/);
  });

  it("refuse les doublons de tâches et de requirements", () => {
    const taskDup = base();
    taskDup.tasks.push({ ...taskDup.tasks[0] });
    expect(() => validateChefBrief(taskDup)).toThrow(/Task dupliquée/);

    const reqDup = base();
    reqDup.requirements.push({ ...reqDup.requirements[0] });
    expect(() => validateChefBrief(reqDup)).toThrow(/Requirement dupliquée/);
  });
});
