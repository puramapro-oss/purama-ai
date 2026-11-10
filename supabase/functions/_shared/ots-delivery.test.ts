import assert from "node:assert/strict";
import test from "node:test";
import { deliverOtsStamp, StampDeliveryError } from "./ots-delivery.ts";

const url = "https://database.fixture.invalid";
const key = "fixture-service-never-live";
const contract = "00000000-0000-4000-8000-000000000001";

async function withTransport(transport: typeof fetch, run: () => Promise<void>) {
  const previous = globalThis.fetch;
  globalThis.fetch = transport;
  try { await run(); } finally { globalThis.fetch = previous; }
}

async function rejectsStatus(operation: Promise<void>, status: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(Promise.race([operation, new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Delivery exceeded the test guard")), 500);
    })]), (error: unknown) => {
      assert.ok(error instanceof StampDeliveryError);
      assert.equal(error.status, status);
      assert.doesNotMatch(error.message, /private-|fixture-service/);
      return true;
    });
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

test("delivery sends the exact service contract, refuses redirects and accepts HTTP success", async () => {
  let requests = 0;
  await withTransport(async (input, init) => {
    requests++;
    assert.equal(String(input), `${url}/functions/v1/contracts-ots-stamp`);
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${key}`);
    assert.deepEqual(JSON.parse(String(init?.body)), { contract_id: contract });
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response(null, { status: 204 });
  }, async () => { await deliverOtsStamp(`${url}/`, key, contract); });
  assert.equal(requests, 1);
});

for (const status of [302, 401, 409, 429, 500]) {
  test(`delivery rejects HTTP ${status} without consuming private response text`, async () => {
    const response = new Response("private-provider-body", { status });
    let reads = 0;
    response.text = () => { reads++; return Promise.resolve("private-provider-body"); };
    await withTransport(async () => response, () => rejectsStatus(deliverOtsStamp(url, key, contract), 502));
    assert.equal(reads, 0);
    assert.equal(response.bodyUsed, true, "unneeded response body is cancelled");
  });
}

for (const synchronous of [false, true]) {
  test(`delivery sanitizes ${synchronous ? "synchronous" : "rejected"} transport errors`, async () => {
    await withTransport((() => {
      if (synchronous) throw new Error("private-provider-error");
      return Promise.reject(new Error("private-provider-error"));
    }) as typeof fetch, () => rejectsStatus(deliverOtsStamp(url, key, contract), 502));
  });
}

test("delivery races a transport that never settles and ignores abort", async () => {
  let signal: AbortSignal | null | undefined;
  await withTransport((_input, init) => {
    signal = init?.signal;
    return new Promise<Response>(() => {});
  }, () => rejectsStatus(deliverOtsStamp(url, key, contract, { timeoutMs: 20 }), 504));
  assert.equal(signal?.aborted, true);
});

test("delivery honors cancellation before starting any transport", async () => {
  const abort = new AbortController(); abort.abort(); let calls = 0;
  await withTransport(async () => { calls++; return new Response(); },
    () => rejectsStatus(deliverOtsStamp(url, key, contract, { signal: abort.signal }), 503));
  assert.equal(calls, 0);
});

test("delivery races cancellation while a transport ignores the signal", async () => {
  const abort = new AbortController(); let signal: AbortSignal | null | undefined;
  await withTransport((_input, init) => {
    signal = init?.signal;
    return new Promise<Response>(() => {});
  }, async () => {
    const operation = deliverOtsStamp(url, key, contract, { signal: abort.signal });
    queueMicrotask(() => abort.abort());
    await rejectsStatus(operation, 503);
  });
  assert.equal(signal?.aborted, true);
});

test("delivery cancels a response arriving after its failed deadline", async () => {
  let resolveLate!: (value: Response) => void; let cancellations = 0;
  await withTransport(() => new Promise<Response>(resolve => { resolveLate = resolve; }), async () => {
    await rejectsStatus(deliverOtsStamp(url, key, contract, { timeoutMs: 20 }), 504);
    resolveLate(new Response(new ReadableStream({ cancel() { cancellations++; } })));
    await new Promise(resolve => setImmediate(resolve));
  });
  assert.equal(cancellations, 1);
});

for (const cancel of ["pending", "rejected"]) {
  test(`delivery never waits for ${cancel} response cancellation`, async () => {
    let cancellations = 0;
    const response = new Response(new ReadableStream({ cancel() {
      cancellations++;
      return cancel === "pending" ? new Promise<void>(() => {}) : Promise.reject(new Error("private-cancel-error"));
    } }));
    await withTransport(async () => response, async () => {
      await deliverOtsStamp(url, key, contract, { timeoutMs: 20 });
    });
    assert.equal(cancellations, 1);
  });
}

test("delivery rejects a late response even when immediate microtasks delay the timer", async () => {
  await withTransport(async () => {
    const end = performance.now() + 25;
    while (performance.now() < end) { /* Simulate a busy synchronous transport. */ }
    return new Response();
  }, () => rejectsStatus(deliverOtsStamp(url, key, contract, { timeoutMs: 10 }), 504));
});

for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
  test(`delivery rejects invalid internal deadline ${String(timeoutMs)}`, async () => {
    let calls = 0;
    await withTransport(async () => { calls++; return new Response(); }, async () => {
      await assert.rejects(deliverOtsStamp(url, key, contract, { timeoutMs }), RangeError);
    });
    assert.equal(calls, 0);
  });
}
