import assert from "node:assert/strict";
import { IaoFacade, IaoRequestNotFoundError } from "../../../karta/src/iao/iaoFacade.ts";
import { handleIaoRoute } from "../../../karta/src/api/iaoRoutes.ts";

const originalNow = Date.now;
const start = originalNow();
let current = start;
Date.now = () => current;
const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const sessionId = "44444444-4444-4444-8444-444444444444";
function identity() {
  return { tenantId: "tenant-a", actorId: "actor-a", session: {
    sessionId, tenantId: "tenant-a", userId: "actor-a", appSlug: "purama-ai",
    issuedAt: start - 1_000, expiresAt: start + 60_000,
  } };
}
function request(id) {
  return { type: "conversation", requestId: id, tenantId: "tenant-a", actorId: "actor-a",
    conversationId: id, prompt: "fixture request", identity: identity() };
}
function completed(id) {
  return { kind: "accepted", preview: "fixture completion", evidence: {
    source: "karta", requestId: id, proofId: sessionId, completedAt: new Date().toISOString(),
  } };
}

const findings = [];
try {
  for (const changed of ["tenant", "actor", "session", "expired-original", "unchanged"]) {
    current = start;
    const claims = identity();
    if (changed === "expired-original") claims.session.expiresAt = start + 500;
    let calls = 0;
    let dispatches = 0;
    let bound;
    const facade = new IaoFacade({ prepare: async input => {
      dispatches++;
      bound = input.identity;
      return { kind: "accepted", preview: "fixture" };
    } });
    const req = { method: "POST", url: "/iao/requests", aborted: false };
    const res = { setHeader() {}, setTimeout() {}, socket: { timeout: 15_000 } };
    const sent = [];
    await handleIaoRoute(req, res, { facade, authenticator: { authenticate: async () => { calls++; return claims; } } },
      async () => {
        if (changed === "tenant") { claims.tenantId = "tenant-b"; claims.session.tenantId = "tenant-b"; }
        if (changed === "actor") { claims.actorId = "actor-b"; claims.session.userId = "actor-b"; }
        if (changed === "session") claims.session.sessionId = ids[1];
        if (changed === "expired-original") { current = start + 600; claims.session.expiresAt = start + 60_000; }
        return { type: "conversation", requestId: ids[0], conversationId: "conversation", prompt: "fixture request" };
      }, (_response, status, body) => sent.push({ status, body }));
    assert.equal(calls, 2);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].status, changed === "unchanged" ? 202 : 401);
    assert.equal(dispatches, changed === "unchanged" ? 1 : 0);
    if (changed === "unchanged") {
      assert.ok(Object.isFrozen(bound));
      assert.ok(Object.isFrozen(bound.session));
      assert.equal(bound.tenantId, "tenant-a");
      assert.equal(bound.session.sessionId, sessionId);
    }
    findings.push({ scenario: "same authenticator object mutated during body read", change: changed,
      status: "PASS", authenticationCalls: calls, dispatches, responseStatus: sent[0].status });
  }

  current = start;
  let finishFirst;
  const first = new Promise(resolve => { finishFirst = resolve; });
  const facade = new IaoFacade({ prepare: input => input.requestId === ids[0] ? first : Promise.resolve(completed(input.requestId)) },
    { retentionMs: 60_000, maxRequests: 2 });
  const firstWork = facade.submit(request(ids[0]));
  current = start + 100;
  await facade.submit(request(ids[1]));
  current = start + 500;
  await facade.submit(request(ids[2]));
  current = start + 900;
  finishFirst(completed(ids[0]));
  await firstWork;
  const retained = ids.map(id => {
    try { return { id, status: facade.get("tenant-a", "actor-a", id).status }; }
    catch (error) {
      if (error instanceof IaoRequestNotFoundError) return { id, status: "evicted" };
      throw error;
    }
  });
  assert.deepEqual(retained.map(item => item.status), ["evicted", "verified", "verified"]);
  findings.push({ scenario: "capacity pressure with completion order different from insertion order", status: "OBSERVED",
    insertionOrder: ids, completionOrder: [ids[1], ids[2], ids[0]], maxRequests: 2, retained,
    conclusion: "The oldest inserted request that is terminal is evicted; eviction does not order by completion timestamp. No policy change made." });
} finally {
  Date.now = originalNow;
}
process.stdout.write(JSON.stringify({ findings }, null, 2) + "\n");
