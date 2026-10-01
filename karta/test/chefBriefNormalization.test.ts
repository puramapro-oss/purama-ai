import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { hashChefBrief, normalizeChefBrief, validateChefBrief, type ChefBrief } from "../src/chef/brief.js";

function brief(): ChefBrief {
  return {
    briefId: "normalization-regression", version: 1, goal: "Preserve the complete verification policy", repo: "example/repo",
    requirements: [{ key: "R1", description: "Implement" }, { key: "R2", description: "Review" }],
    tasks: [
      { key: "T1", title: "Implement", instructions: "Implement", accessMode: "read", requirementKeys: ["R1"], verificationProfiles: ["unit", "security"] },
      { key: "T2", title: "Review", instructions: "Review", accessMode: "read", dependsOn: ["T1"], requirementKeys: ["R2"], verificationProfiles: ["review"] },
    ],
  };
}

describe("CHEF reference normalization", () => {
  it("returns canonical references without changing the caller's brief", () => {
    const input = brief();
    input.tasks[0].verificationProfiles = ["unit", " security "];
    input.tasks[1].dependsOn = [" T1 "];
    input.tasks[1].requirementKeys = [" R2 "];
    const original = structuredClone(input);
    const normalized = normalizeChefBrief(input);
    expect(normalized.tasks[0].verificationProfiles).toEqual(["security", "unit"]);
    expect(normalized.tasks[1].dependsOn).toEqual(["T1"]);
    expect(normalized.tasks[1].requirementKeys).toEqual(["R2"]);
    expect(input).toEqual(original);
    expect(normalizeChefBrief(normalized)).toEqual(normalized);
  });

  it.each([" ", "\t", "\n", "\u00a0"])("rejects dependency cycles obscured by whitespace %j", (padding) => {
    const input = brief();
    input.tasks[0].dependsOn = [padding + "T2" + padding];
    expect(() => validateChefBrief(input)).toThrow(/Cycle/);
    expect(() => normalizeChefBrief(input)).toThrow(/Cycle/);
  });

  it.each(["dependsOn", "requirementKeys", "verificationProfiles"] as const)("rejects canonical duplicates in %s", (field) => {
    const input = brief();
    const value = input.tasks[1][field]![0];
    input.tasks[1][field] = [value, ` ${value} `];
    expect(() => normalizeChefBrief(input)).toThrow(/doublon/);
  });

  it("preserves meaning and hash under generated whitespace and ordering changes", () => {
    const canonical = brief();
    const expected = normalizeChefBrief(canonical);
    const expectedHash = hashChefBrief(canonical);
    fc.assert(fc.property(
      fc.array(fc.constantFrom("", " ", "\t", "\n", "\u00a0"), { minLength: 12, maxLength: 12 }),
      fc.boolean(),
      (padding, reverse) => {
        const input = brief();
        let index = 0;
        const pad = (value: string) => padding[index++ % padding.length] + value + padding[index++ % padding.length];
        for (const requirement of input.requirements) requirement.key = pad(requirement.key);
        for (const task of input.tasks) {
          task.key = pad(task.key);
          task.dependsOn = task.dependsOn?.map(pad);
          task.requirementKeys = task.requirementKeys.map(pad);
          task.verificationProfiles = task.verificationProfiles?.map(pad);
          if (reverse) task.verificationProfiles?.reverse();
        }
        if (reverse) { input.tasks.reverse(); input.requirements.reverse(); }
        expect(normalizeChefBrief(input)).toEqual(expected);
        expect(hashChefBrief(input)).toBe(expectedHash);
      },
    ), { numRuns: 500, seed: 20261001 });
  });
});
