import { describe, expect, it } from "vitest";
import { parseBoundedInteger } from "../src/config.js";

describe("configuration bornee", () => {
  it("conserve le defaut et accepte les bornes", () => {
    expect(parseBoundedInteger("TEST", undefined, 5, 1, 8)).toBe(5);
    expect(parseBoundedInteger("TEST", "1", 5, 1, 8)).toBe(1);
    expect(parseBoundedInteger("TEST", "8", 5, 1, 8)).toBe(8);
  });

  it.each(["0", "9", "2.5", "abc"])("refuse une valeur dangereuse: %s", (value) => {
    expect(() => parseBoundedInteger("TEST", value, 5, 1, 8)).toThrow(/entre 1 et 8/);
  });
});
