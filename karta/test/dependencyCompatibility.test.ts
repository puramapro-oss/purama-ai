import { createRequire } from "node:module";
import cron from "node-cron";
import { describe, expect, it, vi } from "vitest";

describe("patched production dependencies", () => {
  it("retains the real cron v3 lifecycle with the patched CommonJS UUID dependency", () => {
    const callback = vi.fn();
    const task = cron.schedule("*/5 * * * * *", callback, { scheduled: false, runOnInit: true });
    try {
      expect(callback).toHaveBeenCalledOnce();
      const name = (task as unknown as { options: { name: string } }).options.name;
      expect(name).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      task.start();
      task.stop();
      expect(cron.validate("*/5 * * * * *")).toBe(true);
      expect(cron.validate("invalid")).toBe(false);
    } finally {
      task.stop();
      for (const [key, value] of cron.getTasks()) if (value === task) cron.getTasks().delete(key);
    }
  });
  it("preserves the form serialization used by the installed Stripe SDK", () => {
    const require = createRequire(import.meta.url);
    const stripeRequire = createRequire(require.resolve("stripe"));
    const qs = stripeRequire("qs") as { stringify: (value: unknown) => string; parse: (value: string) => unknown };
    const input = { metadata: { note: "présence & calme" }, limit: "3" };
    expect(qs.parse(qs.stringify(input))).toEqual(input);
    expect(qs.parse("__proto__[polluted]=true&constructor[prototype][polluted]=true")).toEqual({});
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
});
