import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KartaRuntimeIaoPort, type IaoCompletionPort, type SmaranaIaoPort } from "../src/iao/kartaRuntimePort.js";
import type { IaoRequest } from "../src/iao/iaoFacade.js";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const RECEIPT_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const STAGES = ["context", "completion", "control"] as const;
const INTERRUPTIONS = ["parent-abort", "deadline"] as const;
type Stage = typeof STAGES[number];
type Settlement = <T>(value: T) => Promise<T>;

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function clock() {
  const time = { now: 0 };
  vi.spyOn(performance, "now").mockImplementation(() => time.now);
  return time;
}

function queueAfter(turns: number, callback: () => void): void {
  queueMicrotask(() => turns > 1 ? queueAfter(turns - 1, callback) : callback());
}

function interceptField<T>(value: T, key: string, read: (original: unknown) => unknown): T {
  const original = (value as Record<string, unknown>)[key];
  Object.defineProperty(value, key, { enumerable: true, configurable: true, get: () => read(original) });
  return value;
}

function request(stage: Stage): IaoRequest {
  const now = Date.now();
  return {
    type: stage === "control" ? "memory-control" : "conversation",
    requestId: REQUEST_ID,
    tenantId: "tenant-a",
    actorId: "actor-a",
    conversationId: "conversation-a",
    prompt: "Synthetic deadline check",
    identity: {
      tenantId: "tenant-a",
      actorId: "actor-a",
      session: {
        sessionId: SESSION_ID, appSlug: "purama-ai", tenantId: "tenant-a", userId: "actor-a",
        issuedAt: now - 1000, expiresAt: now + 60_000,
      },
    },
    ...(stage === "control" ? { memoryControl: { action: "update", data: { value: "synthetic" } } } : {}),
  };
}

function fixture(stage: Stage, settle: Settlement) {
  const signals: AbortSignal[] = [];
  const remember = (signal: AbortSignal | undefined) => { if (signal) signals.push(signal); };
  const buildContext = vi.fn((input: Parameters<SmaranaIaoPort["buildContext"]>[0]) => {
    remember(input.signal);
    const result = { operationId: RECEIPT_ID, context: { sources: [] } };
    return stage === "context" ? settle(result) : Promise.resolve(result);
  });
  const control = vi.fn((input: Parameters<SmaranaIaoPort["control"]>[0]) => {
    remember(input.signal);
    return settle({ action: input.action, operationId: RECEIPT_ID, replayed: false });
  });
  const complete = vi.fn((input: Parameters<IaoCompletionPort["complete"]>[0]) => {
    remember(input.signal);
    const result = { text: "Synthetic answer", modelVersion: "test/local" };
    return stage === "completion" ? settle(result) : Promise.resolve(result);
  });
  return {
    port: new KartaRuntimeIaoPort({ buildContext, control }, { complete }, 100),
    buildContext, control, complete, signals,
  };
}

function expectedInterruption(stage: Stage) {
  return {
    kind: "blocked", reason: "KARTA is unavailable", dependency: "memory-unavailable:karta-runtime",
    effect: stage === "context" ? "none" : "uncertain",
  };
}

describe("KARTA IAO monotonic stage deadlines", () => {
  it.each(STAGES)("accepts %s handed back before its deadline", async stage => {
    const time = clock();
    const deps = fixture(stage, async value => { time.now = 99; return value; });
    await expect(deps.port.prepare(request(stage))).resolves.toMatchObject({ kind: "accepted" });
    expect(deps.signals.every(signal => !signal.aborted)).toBe(true);
  });

  it.each(STAGES.flatMap(stage => [100, 101].map(elapsed => ({ stage, elapsed }))))(
    "rejects $stage resolution at $elapsed before the timer runs", async ({ stage, elapsed }) => {
      const time = clock();
      const deps = fixture(stage, async value => { time.now = elapsed; return value; });
      await expect(deps.port.prepare(request(stage))).resolves.toEqual(expectedInterruption(stage));
      expect(deps.signals.every(signal => signal.aborted)).toBe(true);
      if (stage === "context") expect(deps.complete).not.toHaveBeenCalled();
    },
  );

  it.each(STAGES.flatMap(stage => [100, 101].map(elapsed => ({ stage, elapsed }))))(
    "classifies $stage rejection at $elapsed as interruption", async ({ stage, elapsed }) => {
      const time = clock();
      const deps = fixture(stage, async () => {
        time.now = elapsed;
        throw new Error("memory-denied:synthetic-private-provider-detail");
      });
      await expect(deps.port.prepare(request(stage))).resolves.toEqual(expectedInterruption(stage));
      expect(deps.signals.every(signal => signal.aborted)).toBe(true);
      if (stage === "context") expect(deps.complete).not.toHaveBeenCalled();
    },
  );

  it.each(STAGES)("preserves an early %s denial without exposing provider details", async stage => {
    const time = clock();
    const deps = fixture(stage, async () => {
      time.now = 99;
      throw new Error("memory-denied:synthetic-private-provider-detail");
    });
    await expect(deps.port.prepare(request(stage))).resolves.toEqual({
      kind: "blocked", reason: "KARTA request denied", dependency: "memory-denied:karta-runtime",
    });
    expect(deps.signals.every(signal => !signal.aborted)).toBe(true);
  });

  it.each(["context", "control"] as const)("does not dispatch %s when the budget expires before its first microtask", async stage => {
    const time = clock();
    const deps = fixture(stage, async value => value);
    const pending = deps.port.prepare(request(stage));
    time.now = 100;
    await expect(pending).resolves.toEqual({ ...expectedInterruption(stage), effect: "none" });
    expect(deps.buildContext).not.toHaveBeenCalled();
    expect(deps.control).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it.each(STAGES)("rejects parent cancellation during the final %s Promise handoff", async stage => {
    clock();
    const controller = new AbortController();
    const deps = fixture(stage, value => Promise.resolve().then(() => {
      queueMicrotask(() => queueMicrotask(() => controller.abort()));
      return value;
    }));
    await expect(deps.port.prepare(request(stage), controller.signal)).resolves.toEqual(expectedInterruption(stage));
    expect(deps.signals.every(signal => signal.aborted)).toBe(true);
    if (stage === "context") expect(deps.complete).not.toHaveBeenCalled();
  });

  it.each(STAGES.flatMap(stage => INTERRUPTIONS.map(interruption => ({ stage, interruption })) ))(
    "checks $interruption between bounded and consumption of $stage", async ({ stage, interruption }) => {
      const time = clock();
      const controller = new AbortController();
      const consumed = vi.fn();
      const deps = fixture(stage, value => {
        queueAfter(5, () => { if (interruption === "parent-abort") controller.abort(); else time.now = 100; });
        return Promise.resolve(interceptField(value, stage === "context" ? "operationId" : stage === "control" ? "action" : "text", original => {
          consumed(); return original;
        }));
      });
      await expect(deps.port.prepare(request(stage), controller.signal)).resolves.toEqual(expectedInterruption(stage));
      expect(consumed).not.toHaveBeenCalled();
      if (stage === "context") expect(deps.complete).not.toHaveBeenCalled();
    },
  );

  it.each(INTERRUPTIONS)("checks %s between normalized control and public prepare acceptance", async interruption => {
    const time = clock();
    const controller = new AbortController();
    const normalized = vi.fn();
    const deps = fixture("control", value => {
      queueAfter(6, () => { if (interruption === "parent-abort") controller.abort(); else time.now = 100; });
      return Promise.resolve(interceptField(value, "action", original => { normalized(); return original; }));
    });
    await expect(deps.port.prepare(request("control"), controller.signal)).resolves.toEqual(expectedInterruption("control"));
    expect(normalized).toHaveBeenCalled();
    expect(deps.signals.every(signal => signal.aborted)).toBe(true);
  });

  it.each(STAGES.flatMap(stage => INTERRUPTIONS.flatMap(interruption => [false, true].map(throws => ({ stage, interruption, throws })))))(
    "keeps $stage interrupted by $interruption during validation (throws=$throws)", async ({ stage, interruption, throws }) => {
      const time = clock();
      const controller = new AbortController();
      const deps = fixture(stage, value => Promise.resolve(interceptField(
        value, stage === "context" ? "operationId" : stage === "control" ? "action" : "text", original => {
          if (interruption === "parent-abort") controller.abort(); else time.now = 100;
          if (throws) throw new Error("memory-denied:synthetic-private-validation-detail");
          return original;
        },
      )));
      await expect(deps.port.prepare(request(stage), controller.signal)).resolves.toEqual(expectedInterruption(stage));
      expect(deps.signals.every(signal => signal.aborted)).toBe(true);
      if (stage === "context") expect(deps.complete).not.toHaveBeenCalled();
    },
  );

  it.each(INTERRUPTIONS)("includes context extraction in its own budget on %s", async interruption => {
    const time = clock();
    const controller = new AbortController();
    const deps = fixture("context", value => Promise.resolve(interceptField(value, "context", original => {
      if (interruption === "parent-abort") controller.abort(); else time.now = 100;
      return original;
    })));
    await expect(deps.port.prepare(request("context"), controller.signal)).resolves.toEqual(expectedInterruption("context"));
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it.each(INTERRUPTIONS)("retains effect none when %s occurs before completion dispatch", async interruption => {
    const time = clock();
    const controller = new AbortController();
    const deps = fixture("context", value => Promise.resolve(interceptField(value, "context", original => {
      queueMicrotask(() => { if (interruption === "parent-abort") controller.abort(); else time.now = 100; });
      return original;
    })));
    await expect(deps.port.prepare(request("context"), controller.signal)).resolves.toEqual(expectedInterruption("context"));
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it.each((["completion", "control"] as const).flatMap(stage => INTERRUPTIONS.map(interruption => ({ stage, interruption }))))(
    "does not revoke $stage already accepted before later $interruption", async ({ stage, interruption }) => {
      const time = clock();
      const controller = new AbortController();
      const deps = fixture(stage, value => {
        queueAfter(stage === "control" ? 7 : 6, () => { if (interruption === "parent-abort") controller.abort(); else time.now = 100; });
        return Promise.resolve(value);
      });
      await expect(deps.port.prepare(request(stage), controller.signal)).resolves.toMatchObject({ kind: "accepted" });
      expect(deps.signals.every(signal => !signal.aborted)).toBe(true);
    },
  );

  it.each(STAGES)("cleans up after an uncooperative %s never settles", async stage => {
    vi.useFakeTimers();
    const deps = fixture(stage, () => new Promise<never>(() => {}));
    const pending = deps.port.prepare(request(stage));
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual(expectedInterruption(stage));
    expect(deps.signals.length).toBeGreaterThan(0);
    expect(deps.signals.every(signal => signal.aborted)).toBe(true);
    for (const signal of deps.signals) expect(getEventListeners(signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    if (stage === "context") expect(deps.complete).not.toHaveBeenCalled();
  });

  it("keeps separate stage budgets and the shared controller live after a successful context", async () => {
    const time = clock();
    const signals: AbortSignal[] = [];
    const smarana = {
      buildContext: vi.fn(async (input: Parameters<SmaranaIaoPort["buildContext"]>[0]) => {
        signals.push(input.signal!);
        time.now = 99;
        return { operationId: RECEIPT_ID, context: { sources: [] } };
      }),
      control: vi.fn(),
    } satisfies SmaranaIaoPort;
    const completion = {
      complete: vi.fn(async (input: Parameters<IaoCompletionPort["complete"]>[0]) => {
        signals.push(input.signal!);
        expect(input.signal?.aborted).toBe(false);
        time.now = 198;
        return { text: "Synthetic answer", modelVersion: "test/local" };
      }),
    } satisfies IaoCompletionPort;
    await expect(new KartaRuntimeIaoPort(smarana, completion, 100).prepare(request("context")))
      .resolves.toMatchObject({ kind: "accepted", preview: "Synthetic answer", evidence: { proofId: RECEIPT_ID } });
    expect(completion.complete).toHaveBeenCalledOnce();
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(signals.every(signal => !signal.aborted)).toBe(true);
  });
});
