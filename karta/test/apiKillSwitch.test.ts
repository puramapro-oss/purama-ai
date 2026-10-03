import { describe, expect, it } from "vitest";
import { strictActiveFlag } from "../src/api/server.js";

describe("API kill switch — parsing strict", () => {
  it.each([
    [{ active: true }, true],
    [{ active: false }, false],
  ] as const)("accepte uniquement le booléen %s", (body, expected) => {
    expect(strictActiveFlag(body)).toBe(expected);
  });

  it.each([
    {},
    { active: "true" },
    { active: "false" },
    { active: 1 },
    { active: 0 },
    { active: null },
  ])("refuse une valeur ambiguë sans la convertir: %j", (body) => {
    expect(strictActiveFlag(body)).toBeUndefined();
  });
});
