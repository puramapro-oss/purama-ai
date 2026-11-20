import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  ready: undefined as unknown as Promise<void>,
  initializationObserved: false,
  closedBeforeInitialization: false,
  disconnect: vi.fn<() => void>(),
  close: vi.fn<() => Promise<void>>(),
  rpc: vi.fn(),
}));

vi.mock("../src/config.js", () => ({ config: { redisUrl: "redis://127.0.0.1:1" } }));
vi.mock("../src/db/supabase.js", () => ({ supabase: { rpc: fixture.rpc } }));
vi.mock("../src/queue/queues.js", () => ({ enqueueCycleDelivery: vi.fn() }));
vi.mock("ioredis", () => ({ Redis: class {
  on() { return this; }
  disconnect() { fixture.disconnect(); }
} }));
vi.mock("bullmq", () => ({ Queue: class {
  on() { return this; }
  waitUntilReady() { return fixture.ready; }
  close() { return fixture.close(); }
} }));

import { startApprovalOutboxRelay } from "../src/queue/approval-outbox.js";

function initialization() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  fixture.ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // Model the dependency's already-registered initialization/error reaction.
  // The native Redis gate separately checks the real BullMQ emitter and rejects
  // every unhandled rejection; these unit cases only control settlement timing.
  const observed = fixture.ready.then(
    () => { fixture.initializationObserved = true; },
    () => { fixture.initializationObserved = true; },
  );
  return { resolve, reject, observed };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  fixture.initializationObserved = false;
  fixture.closedBeforeInitialization = false;
  fixture.disconnect.mockReset();
  fixture.rpc.mockReset();
  fixture.close.mockReset().mockImplementation(async () => {
    fixture.closedBeforeInitialization = !fixture.initializationObserved;
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("approval outbox private producer shutdown", () => {
  it("closes an initialized producer once and admits no poll after stop", async () => {
    const init = initialization();
    init.resolve();
    await init.observed;
    const relay = startApprovalOutboxRelay();
    const stop = relay.stop();
    expect(relay.stop()).toBe(stop);
    await stop;
    await vi.advanceTimersByTimeAsync(10_500);
    expect(fixture.disconnect).toHaveBeenCalledTimes(1);
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.closedBeforeInitialization).toBe(false);
    expect(fixture.rpc).not.toHaveBeenCalled();
    expect(relay.getHealth().running).toBe(false);
  });

  it("keeps queue error forwarding until disconnect rejects initialization", async () => {
    const init = initialization();
    fixture.disconnect.mockImplementation(() => {
      queueMicrotask(() => init.reject(new Error("Owned connection closed during initialization")));
    });
    const relay = startApprovalOutboxRelay();
    await relay.stop();
    await init.observed;
    expect(fixture.disconnect).toHaveBeenCalledTimes(1);
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.closedBeforeInitialization).toBe(false);
    expect(fixture.rpc).not.toHaveBeenCalled();
  });

  it("returns at its deadline and closes only after a late initialization rejection", async () => {
    const init = initialization();
    const relay = startApprovalOutboxRelay();
    const stop = relay.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await stop;
    expect(fixture.disconnect).toHaveBeenCalledTimes(1);
    expect(fixture.close).not.toHaveBeenCalled();
    expect(relay.getHealth().running).toBe(false);
    init.reject(new Error("Owned initialization rejected after the stop deadline"));
    await init.observed;
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.closedBeforeInitialization).toBe(false);
    expect(fixture.rpc).not.toHaveBeenCalled();
  });

  it("stays bounded without closing an initialization that never settles", async () => {
    initialization();
    const relay = startApprovalOutboxRelay();
    const stop = relay.stop();
    let returned = false;
    void stop.then(() => { returned = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stop;
    expect(returned).toBe(true);
    expect(fixture.disconnect).toHaveBeenCalledTimes(1);
    expect(fixture.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_500);
    expect(fixture.close).not.toHaveBeenCalled();
    expect(fixture.rpc).not.toHaveBeenCalled();
    expect(relay.getHealth().running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
