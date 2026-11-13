import { readdir } from "node:fs/promises";
import { expect, it } from "vitest";

it("keeps a unique numeric KARTA migration order across composed feature branches", async () => {
  const files = (await readdir(new URL("../migrations/", import.meta.url))).filter(name => /^\d+_.*\.sql$/.test(name));
  const versions = files.map(name => Number(name.split("_", 1)[0]));
  expect(new Set(versions).size, "Two migrations must not claim the same numeric version").toBe(files.length);
  expect(files).toContain("030_chef_capability_selection.sql");
  expect(files).toContain("031_chef_workshop.sql");
});
