import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const runtimePath = new URL("../../public/offline-workspace.js", import.meta.url);
const runtimeSource = readFileSync(runtimePath, "utf8");
const startAnchor = "  function waitForActivation(";
const endAnchor = "\n  async function prepareOffline(";
const start = runtimeSource.indexOf(startAnchor);
const end = runtimeSource.indexOf(endAnchor, start + startAnchor.length);

// Fail explicitly if the production helper moves or changes its surrounding
// declaration boundary. Only its actual source is evaluated, never a rewrite.
assert.notEqual(start, -1, "The waitForActivation declaration anchor must exist.");
assert.equal(runtimeSource.lastIndexOf(startAnchor), start, "The helper anchor must be unique.");
assert.ok(end > start, "prepareOffline must follow waitForActivation.");
assert.equal(runtimeSource.lastIndexOf(endAnchor), end, "The ending anchor must be unique.");
const helperSource = runtimeSource.slice(start, end).trim();
assert.match(helperSource, /^function waitForActivation\(registration\) \{/);

function fixture() {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  const scheduled = [];
  const cleared = [];
  const sandbox = {
    setTimeout(callback, delay) {
      const id = nextId++;
      const timer = { id, callback, delay, due: time + delay };
      timers.set(id, timer);
      scheduled.push(timer);
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      timers.delete(id);
    },
  };
  const helper = vm.runInNewContext("(" + helperSource + ")", sandbox, {
    filename: runtimePath.pathname + "#waitForActivation",
    timeout: 1000,
  });

  function advance(milliseconds) {
    time += milliseconds;
    let due = [...timers.values()].filter((timer) => timer.due <= time);
    while (due.length) {
      due.sort((left, right) => left.due - right.due || left.id - right.id);
      for (const timer of due) {
        if (!timers.delete(timer.id)) continue;
        timer.callback();
      }
      due = [...timers.values()].filter((timer) => timer.due <= time);
    }
  }

  async function finish(operation) {
    // Finish pending helper promises even when an assertion fails. No real
    // twelve-second timer exists: callbacks run against this virtual clock.
    if (timers.size) advance(Math.max(...[...timers.values()].map((timer) => timer.due)) - time);
    await operation.settled;
  }

  return { helper, timers, scheduled, cleared, advance, finish };
}

function worker(initialState) {
  const listeners = new Set();
  const added = [];
  const removed = [];
  const value = {
    state: initialState,
    addEventListener(type, listener) {
      assert.equal(type, "statechange");
      added.push(listener);
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, "statechange");
      removed.push(listener);
      listeners.delete(listener);
    },
  };
  return {
    value,
    listeners,
    added,
    removed,
    transition(state) {
      value.state = state;
      for (const listener of [...listeners]) listener.call(value, { type: "statechange" });
    },
  };
}

function observe(promise) {
  const result = { status: "pending" };
  const settled = promise.then(
    () => { result.status = "fulfilled"; },
    (error) => { result.status = "rejected"; result.error = error; },
  );
  return { result, settled };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function assertReleased(clock, selectedWorker) {
  assert.equal(clock.timers.size, 0, "No activation timer may remain.");
  assert.equal(selectedWorker.listeners.size, 0, "The statechange listener must be removed.");
  assert.equal(selectedWorker.removed.length, 1, "The listener must be removed exactly once.");
  assert.equal(selectedWorker.removed[0], selectedWorker.added[0], "The registered listener must be removed.");
  assert.deepEqual(clock.cleared, [clock.scheduled[0].id], "The activation timer must be cleared.");
}

test("an already activated active worker resolves without installing listeners or timers", async () => {
  const clock = fixture();
  const active = worker("activated");
  const operation = observe(clock.helper({ active: active.value, installing: null, waiting: null }));
  try {
    await flushMicrotasks();
    assert.equal(operation.result.status, "fulfilled");
    assert.equal(active.listeners.size, 0);
    assert.equal(active.added.length, 0);
    assert.equal(clock.timers.size, 0);
    assert.equal(clock.scheduled.length, 0);
  } finally {
    await clock.finish(operation);
  }
});

test("an activating active worker stays pending until its activated statechange", async () => {
  const clock = fixture();
  const active = worker("activating");
  const operation = observe(clock.helper({ active: active.value, installing: null, waiting: null }));
  try {
    await flushMicrotasks();
    assert.equal(operation.result.status, "pending",
      "registration.active in state activating must not be treated as ready.");
    assert.equal(active.listeners.size, 1);
    assert.equal(clock.scheduled.length, 1);
    assert.equal(clock.scheduled[0].delay, 12000);

    active.transition("activating");
    await flushMicrotasks();
    assert.equal(operation.result.status, "pending");
    active.transition("activated");
    await flushMicrotasks();
    assert.equal(operation.result.status, "fulfilled");
    assertReleased(clock, active);
  } finally {
    await clock.finish(operation);
  }
});

test("a selected worker becoming redundant rejects and releases its listener and timer", async () => {
  const clock = fixture();
  const installing = worker("installing");
  const operation = observe(clock.helper({ installing: installing.value, waiting: null, active: null }));
  try {
    await flushMicrotasks();
    assert.equal(operation.result.status, "pending");
    assert.equal(installing.listeners.size, 1);
    installing.transition("redundant");
    await flushMicrotasks();
    assert.equal(operation.result.status, "rejected");
    assert.match(operation.result.error.message, /Installation failed/);
    assertReleased(clock, installing);
  } finally {
    await clock.finish(operation);
  }
});

test("a new installing worker takes priority over an old already activated active worker", async () => {
  const clock = fixture();
  const active = worker("activated");
  const installing = worker("installing");
  const operation = observe(clock.helper({ active: active.value, installing: installing.value, waiting: null }));
  try {
    await flushMicrotasks();
    assert.equal(operation.result.status, "pending");
    assert.equal(installing.listeners.size, 1);
    assert.equal(active.listeners.size, 0);
    assert.equal(active.added.length, 0);

    installing.transition("installed");
    await flushMicrotasks();
    assert.equal(operation.result.status, "pending");
    installing.transition("activated");
    await flushMicrotasks();
    assert.equal(operation.result.status, "fulfilled");
    assertReleased(clock, installing);
  } finally {
    await clock.finish(operation);
  }
});

test("the timeout remains exactly twelve seconds and releases its listener and timer", async () => {
  const clock = fixture();
  const waiting = worker("installed");
  const operation = observe(clock.helper({ active: null, installing: null, waiting: waiting.value }));
  try {
    await flushMicrotasks();
    assert.equal(operation.result.status, "pending");
    assert.equal(clock.scheduled.length, 1);
    assert.equal(clock.scheduled[0].delay, 12000);
    assert.equal(waiting.listeners.size, 1);

    clock.advance(11999);
    await flushMicrotasks();
    assert.equal(operation.result.status, "pending");
    assert.equal(clock.timers.size, 1);
    clock.advance(1);
    await flushMicrotasks();
    assert.equal(operation.result.status, "rejected");
    assert.match(operation.result.error.message, /Activation timeout/);
    assertReleased(clock, waiting);
  } finally {
    await clock.finish(operation);
  }
});
