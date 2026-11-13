import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";

type Handler = (request: Request) => Promise<Response>;
const root = new URL("../../supabase/functions/", import.meta.url);
function compile(path: string) {
  return ts.transpileModule(readFileSync(new URL(path, root), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}
const endpoint = compile("chef-workshop/index.ts");
const limiterSource = compile("_shared/rate-limit.ts");
const owner = "00000000-0000-4000-8000-000000000001";
const missionId = "abcdef01-0000-4000-8000-000000000011";
const requestId = "abcdef02-0000-4000-8000-000000000012";
const taskId = "abcdef03-0000-4000-8000-000000000013";
const projectId = "site-public";
const start = { action: "start", projectId, requestId, prompt: "Créer le site de présentation de mon atelier." };
const summary = {
  id: missionId, projectId, title: "Créer le site", state: "active",
  createdAt: "2026-11-12T05:00:00.000Z", updatedAt: "2026-11-12T05:00:00.000Z",
  finishedAt: null, verifiedTasks: 0, totalTasks: 1, usage: { tokens: 0, costMicros: 0 },
};
const task = { id: taskId, key: "build", title: "Construire", state: "ready", provider: "codex", attempt: 0, outputSha: null, evidenceCount: 0 };
const detail = { ...summary, tasks: [task] };
const accepted = { ok: true, mission: detail };
const overview = { ok: true, projects: [{ id: projectId, name: "Mon site", ready: true, maxParallel: 2 }], missions: [summary] };
function artifactFixture() {
  // A real ZIP produced independently with Python zipfile, containing index.html.
  const base64 = "UEsDBBQAAAAAANoNbV1A7aWGHwAAAB8AAAAKAAAAaW5kZXguaHRtbDwhZG9jdHlwZSBodG1sPjxoMT5Cb25qb3VyPC9oMT5QSwECFAMUAAAAAADaDW1dQO2lhh8AAAAfAAAACgAAAAAAAAAAAAAAgAEAAAAAaW5kZXguaHRtbFBLBQYAAAAAAQABADgAAABHAAAAAAA=";
  const bytes = Buffer.from(base64,"base64");
  const content = "<!doctype html><h1>Bonjour</h1>";
  return {missionId,commitSha:"a".repeat(40),archive:{fileName:"site-sources.zip",mediaType:"application/zip",base64,
    sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length},
    preview:{fileName:"preview.html",mediaType:"text/html",content,
      sha256:createHash("sha256").update(content).digest("hex"),bytes:Buffer.byteLength(content)}};
}

function harness() {
  const events: string[] = [];
  const state = {
    env: { SUPABASE_URL: "https://db.example.invalid", SUPABASE_ANON_KEY: "test-public-key",
      KARTA_INTERNAL_URL: "http://internal.example.invalid", KARTA_ADMIN_TOKEN: "test-admin-secret" } as Record<string, string | undefined>,
    auth: { data: { user: { id: owner } }, error: null } as { data: unknown; error: unknown },
  };
  const getUser = vi.fn(async (_token: string) => { events.push("auth"); return state.auth; });
  const createClient = vi.fn((_url: string, _key: string, _options: unknown) => ({ auth: { getUser } }));
  const limiter: Record<string, unknown> = {};
  new Function("require", "exports", limiterSource)(() => { throw new Error("Unexpected limiter import"); }, limiter);
  const realLimit = limiter.rateLimit as (key: string, max: number, window: number) => { allowed: boolean; remaining: number };
  const rateLimit = vi.fn((key: string, max: number, window: number) => { events.push("limit"); return realLimit(key, max, window); });
  const fetch = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => { events.push("fetch"); return Response.json(accepted, { status: 202 }); });
  let handle: Handler | undefined;
  const require = (name: string) => {
    if (name === "npm:@supabase/supabase-js@2.91.0") return { createClient };
    if (name === "../_shared/rate-limit.ts") return { rateLimit };
    throw new Error("Unexpected import: " + name);
  };
  new Function("require", "exports", "Deno", "fetch", endpoint)(require, {}, {
    serve: (fn: Handler) => { handle = fn; }, env: { get: (name: string) => state.env[name] },
  }, fetch);
  if (!handle) throw new Error("Missing Deno handler");
  return { handle, state, getUser, createClient, rateLimit, fetch, events };
}
function request(body: unknown = start, authorization: string | null = "Bearer user-token", signal?: AbortSignal) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (authorization !== null) headers.set("Authorization", authorization);
  return new Request("https://edge.example.invalid/chef-workshop", {
    method: "POST", headers, signal, body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
function response(h: ReturnType<typeof harness>, body: unknown, status = 200) {
  h.fetch.mockImplementation(async () => Response.json(body, { status }));
}
afterEach(() => vi.useRealTimers());

describe("CHEF workshop authenticated artifact receipts", () => {
  it("binds the requested mission and verifies exact ZIP/HTML bytes before forwarding a public receipt", async () => {
    const h=harness(); const artifact=artifactFixture();
    response(h,{ok:true,artifact:{...artifact,secret:"PRIVATE",archive:{...artifact.archive,workdir:"PRIVATE"}}});
    const result=await h.handle(request({action:"artifact",missionId:missionId.toUpperCase()}));
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ok:true,artifact});
    expect(JSON.parse(h.fetch.mock.calls[0][1]?.body as string)).toEqual({action:"artifact",missionId});
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(h.rateLimit).toHaveBeenLastCalledWith("chef-workshop:artifact:"+owner,15,60000);
  });
  it.each(["other-mission","bad-sha","bad-filename","bad-media","bad-size","bad-hash","bad-base64","bad-preview-hash","preview-overflow","preview-controls"])("refuses an inconsistent artifact: %s",async reason=>{
      const h=harness();const artifact=artifactFixture();
      if(reason==="other-mission")artifact.missionId=requestId;
      if(reason==="bad-sha")artifact.commitSha="--help";
      if(reason==="bad-filename")artifact.archive.fileName="../../secret.zip";
      if(reason==="bad-media")artifact.archive.mediaType="text/html";
      if(reason==="bad-size")artifact.archive.bytes++;
      if(reason==="bad-hash")artifact.archive.sha256="b".repeat(64);
      if(reason==="bad-base64")artifact.archive.base64="x"+artifact.archive.base64;
      if(reason==="bad-preview-hash")artifact.preview.sha256="b".repeat(64);
      if(reason==="preview-overflow")artifact.preview.content="x".repeat(200*1024+1);
      if(reason==="preview-controls")artifact.preview.content="<html>\0</html>";
      response(h,{ok:true,artifact});
      expect((await h.handle(request({action:"artifact",missionId}))).status).toBe(502);
    });
  it.each([{action:"artifact",missionId,path:"/etc/passwd"},{action:"artifact",missionId,sha:"a".repeat(40)},{action:"artifact",missionId:"not-uuid"}])("rejects client-selected paths and commits: %#",async body=>{
      const h=harness();expect((await h.handle(request(body))).status).toBe(400);expect(h.fetch).not.toHaveBeenCalled();
    });
  it("uses a separate bounded transport limit for artifacts without relaxing status responses",async()=>{
    const h=harness(); const large={ok:true,artifact:artifactFixture(),padding:"x".repeat(600_000)};
    response(h,large);expect((await h.handle(request({action:"artifact",missionId}))).status).toBe(200);
    response(h,{...accepted,padding:large.padding});expect((await h.handle(request({action:"status",missionId}))).status).toBe(502);
  });
  it("cancels an artifact response above six MiB",async()=>{
    const h=harness(); const cancel=vi.fn();
    h.fetch.mockImplementation(async()=>new Response(new ReadableStream<Uint8Array>({pull(c){c.enqueue(new Uint8Array(1024*1024));},cancel})));
    expect((await h.handle(request({action:"artifact",missionId}))).status).toBe(502);expect(cancel).toHaveBeenCalledOnce();
  });
  it("keeps status and cancellation available after the heavier artifact quota is exhausted",async()=>{
    const h=harness();response(h,{ok:true,artifact:artifactFixture()});
    for(let i=0;i<15;i++)expect((await h.handle(request({action:"artifact",missionId}))).status).toBe(200);
    expect((await h.handle(request({action:"artifact",missionId}))).status).toBe(429);
    response(h,accepted);expect((await h.handle(request({action:"status",missionId}))).status).toBe(200);
    expect((await h.handle(request({action:"cancel",missionId}))).status).toBe(200);
  });
  it("keeps the deadline effective during asynchronous artifact hash validation",async()=>{
    vi.useFakeTimers();const h=harness();response(h,{ok:true,artifact:artifactFixture()});
    const original=crypto.subtle.digest.bind(crypto.subtle);
    let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
    let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});
    const hash=vi.spyOn(crypto.subtle,"digest").mockImplementationOnce(async(algorithm,data)=>{
      entered();await hold;return original(algorithm,data);
    });
    try {
      const pending=h.handle(request({action:"artifact",missionId}));
      await started;await vi.advanceTimersByTimeAsync(10001);release();
      expect((await pending).status).toBe(504);expect(vi.getTimerCount()).toBe(0);
    } finally {hash.mockRestore();release();}
  });
});

describe("CHEF workshop authenticated edge boundary", () => {
  it("handles preflight and rejects unsupported methods without accessing account services", async () => {
    const h = harness();
    const preflight = await h.handle(new Request("https://edge.example.invalid", { method: "OPTIONS" }));
    expect(preflight.status).toBe(200);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect((await h.handle(new Request("https://edge.example.invalid"))).status).toBe(405);
    expect(h.getUser).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([null, "", "Basic token", "Bearer ", "Bearer two tokens"])("requires a bearer credential (%#)", async authorization => {
    const h = harness(); expect((await h.handle(request(start, authorization))).status).toBe(401);
    expect(h.createClient).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { data: { user: null }, error: null },
    { data: { user: { id: owner } }, error: { message: "PRIVATE_AUTH" } },
    { data: { user: { id: "../../somebody" } }, error: null },
  ])("requires an authenticated canonical identity (%#)", async auth => {
    const h = harness(); h.state.auth = auth;
    const result = await h.handle(request());
    expect(result.status).toBe(401); expect(await result.text()).not.toContain("PRIVATE_AUTH");
    expect(h.getUser).toHaveBeenCalledExactlyOnceWith("user-token");
    expect(h.rateLimit).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
  });
  it("rejects an owner supplied by the browser and uses the authenticated owner's route", async () => {
    const h = harness();
    expect((await h.handle(request({ ...start, userId: requestId }))).status).toBe(400);
    expect(h.events).toEqual(["auth"]);
    const result = await h.handle(request({ ...start, requestId: requestId.toUpperCase(), prompt: "  " + start.prompt + "  " }));
    expect(result.status).toBe(202);
    const [url, init] = h.fetch.mock.calls[0];
    expect(url).toBe("http://internal.example.invalid/workshop/" + owner);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-admin-secret");
    expect(JSON.parse(init?.body as string)).toEqual(start);
    expect(JSON.stringify(init)).not.toContain("user-token");
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(h.events).toEqual(["auth", "auth", "limit", "fetch"]);
  });
  it.each([
    [], null, {}, "{broken", { action: "list", userId: owner }, { action: "list", projectId },
    { action: "status", missionId: "../forged" }, { action: "cancel", missionId, prompt: "extra" },
    { ...start, requestId: undefined }, { ...start, requestId: "not-uuid" },
    { ...start, projectId: "../secret" }, { ...start, worktree: "/tmp/private" },
    { ...start, command: "shell command" }, { ...start, prompt: "too short" },
    { ...start, prompt: " ".repeat(50) }, { ...start, prompt: "x".repeat(6001) },
    { ...start, prompt: "A legitimate prompt\u0000with a null byte" },
  ])("refuses incomplete, extra and invalid arguments before forwarding (%#)", async body => {
    const h = harness(); expect((await h.handle(request(body))).status).toBe(400);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each(["x".repeat(6000), "界".repeat(6000), "😀".repeat(3000)])("accepts a bounded Unicode prompt (%#)", async prompt => {
    const h = harness(); expect((await h.handle(request({ ...start, prompt }))).status).toBe(202);
  });
  it("bounds transport bytes even if Content-Length lies", async () => {
    const h = harness(); const input = request("x".repeat(65537)); input.headers.set("Content-Length", "1");
    expect((await h.handle(input)).status).toBe(413); expect(h.fetch).not.toHaveBeenCalled();
  });
  it("cancels an oversized chunked stream before parsing", async () => {
    const h = harness(); const cancel = vi.fn(); let chunks = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(32768)); }, cancel,
    });
    const input = new Request("https://edge.example.invalid", {
      method: "POST", headers: { Authorization: "Bearer user-token" }, body: stream, duplex: "half",
    } as RequestInit);
    expect((await h.handle(input)).status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce(); expect(chunks).toBeLessThan(6); expect(h.fetch).not.toHaveBeenCalled();
  });
  it("rejects malformed UTF-8 instead of accepting replacement characters", async () => {
    const h = harness();
    const input = new Request("https://edge.example.invalid", {
      method: "POST", headers: { Authorization: "Bearer user-token" }, body: new Uint8Array([0xc0, 0xaf]),
    });
    expect((await h.handle(input)).status).toBe(400); expect(h.fetch).not.toHaveBeenCalled();
  });
  it("keeps listing and emergency cancellation independent of exhausted submission limits", async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) expect((await h.handle(request())).status).toBe(202);
    expect((await h.handle(request())).status).toBe(429);
    response(h, overview);
    for (let i = 0; i < 120; i++) expect((await h.handle(request({ action: "list" }))).status).toBe(200);
    expect((await h.handle(request({ action: "list" }))).status).toBe(429);
    response(h, { ok: true, mission: { ...detail, state: "cancelling" } });
    const cancellation = await h.handle(request({ action: "cancel", missionId }));
    expect(cancellation.status).toBe(200);
    expect(await cancellation.json()).toHaveProperty("mission.state", "cancelling");
    expect(h.rateLimit).toHaveBeenLastCalledWith("chef-workshop:cancel:" + owner, 120, 60000);
    expect(h.fetch).toHaveBeenCalledTimes(131);
  });
  it.each(["SUPABASE_URL", "SUPABASE_ANON_KEY", "KARTA_INTERNAL_URL", "KARTA_ADMIN_TOKEN"])("fails closed without %s", async key => {
    const h = harness(); delete h.state.env[key];
    expect((await h.handle(request())).status).toBe(503); expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each(["file:///secret", "https://user:password@internal.invalid", "https://internal.invalid?token=secret", "https://internal.invalid/#secret"])("rejects unsafe server URL configuration (%#)", async url => {
    const h = harness(); h.state.env.KARTA_INTERNAL_URL = url;
    const result = await h.handle(request());
    expect(result.status).toBe(503); expect(await result.text()).not.toContain("secret"); expect(h.fetch).not.toHaveBeenCalled();
  });
  it("preserves a configured base path and canonicalizes requested mission identity", async () => {
    const h = harness(); h.state.env.KARTA_INTERNAL_URL = "https://internal.invalid/karta/";
    response(h, accepted);
    expect((await h.handle(request({ action: "status", missionId: missionId.toUpperCase() }))).status).toBe(200);
    expect(h.fetch.mock.calls[0][0]).toBe("https://internal.invalid/karta/workshop/" + owner);
    expect(JSON.parse(h.fetch.mock.calls[0][1]?.body as string)).toEqual({ action: "status", missionId });
  });
});

describe("CHEF workshop public receipts and failure handling", () => {
  it("projects only approved fields and never confuses recorded admission with completed work", async () => {
    const h = harness();
    response(h, { ...accepted, internal: "PRIVATE", mission: { ...detail, userId: owner, worktree: "/PRIVATE",
      prompt: "PRIVATE", previewUrl: "https://PRIVATE.invalid", tasks: [{ ...task, providerTrace: "PRIVATE", instructions: "PRIVATE",
        outputSha: "a".repeat(40) }] } }, 202);
    const result = await (await h.handle(request())).json();
    expect(result).toEqual(accepted);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(result).toHaveProperty("mission.state", "active");
    expect(result).toHaveProperty("mission.tasks.0.outputSha", null);
  });
  it("accepts a title derived from a valid multiline prompt", async () => {
    const h = harness();
    response(h, { ok: true, mission: { ...detail, title: "Créer le site\navec une galerie et un formulaire" } });
    const result = await h.handle(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toHaveProperty("mission.title", expect.stringContaining("\n"));
  });
  it("redacts provider readiness errors but keeps explicit unavailability", async () => {
    const h = harness();
    response(h, { ...overview, projects: [{ ...overview.projects[0], ready: false, unavailableReason: "/PRIVATE credentials=secret" }] });
    const result = await (await h.handle(request({ action: "list" }))).json();
    expect(result).toHaveProperty("projects.0.ready", false);
    expect(result).toHaveProperty("projects.0.unavailableReason", expect.stringContaining("Aucun exécuteur"));
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(JSON.stringify(result)).not.toContain("credentials");
  });
  it("returns a verified SHA and HTTPS preview only with a verified mission", async () => {
    const h = harness();
    const complete = { ...detail, state: "verified_done", verifiedTasks: 1, finishedAt: "2026-11-12T06:00:00.000Z",
      previewUrl: "https://preview.example.invalid/result",
      tasks: [{ ...task, state: "verified_done", attempt: 1, evidenceCount: 2, outputSha: "A".repeat(40) }] };
    response(h, { ok: true, mission: complete });
    const result = await (await h.handle(request({ action: "status", missionId }))).json();
    expect(result).toHaveProperty("mission.previewUrl", complete.previewUrl);
    expect(result).toHaveProperty("mission.tasks.0.outputSha", "a".repeat(40));
  });
  it.each([
    { ...detail, id: requestId }, { ...detail, tasks: [] }, { ...detail, verifiedTasks: 1 },
    { ...detail, createdAt: "not-a-date" }, { ...detail, state: "perfect" }, { ...detail, usage: { tokens: -1, costMicros: 0 } },
    { ...detail, tasks: [{ ...task, provider: "invented" }] }, { ...detail, tasks: [{ ...task, outputSha: "not-a-sha" }] },
    { ...detail, tasks: [{ ...task, attempt: 1.1 }] },
    { ...detail, state: "verified_done", previewUrl: "javascript:alert(1)" },
    { ...detail, state: "verified_done", previewUrl: "https://secret:token@preview.invalid/" },
  ])("rejects inconsistent or unsafe mission receipts (%#)", async mission => {
    const h = harness(); response(h, { ok: true, mission });
    const result = await h.handle(request({ action: "status", missionId }));
    expect(result.status).toBe(502); expect(await result.text()).not.toContain("secret");
  });
  it("rejects a start receipt for a different project", async () => {
    const h = harness(); response(h, { ok: true, mission: { ...detail, projectId: "other" } });
    expect((await h.handle(request())).status).toBe(502);
  });
  it("rejects duplicate tasks and overlarge lists", async () => {
    const h = harness();
    response(h, { ok: true, mission: { ...detail, totalTasks: 2, tasks: [task, task] } });
    expect((await h.handle(request())).status).toBe(502);
    response(h, { ...overview, projects: Array.from({ length: 65 }, (_, n) => ({ ...overview.projects[0], id: "site-" + n })) });
    expect((await h.handle(request({ action: "list" }))).status).toBe(502);
  });
  it.each([400, 401, 403, 404, 409, 413, 429, 503])("keeps actionable upstream status %s while removing all error text", async status => {
    const h = harness(); response(h, { error: "PRIVATE /home/token", code: "PRIVATE_CODE", stack: "PRIVATE" }, status);
    const result = await h.handle(request());
    expect(result.status).toBe(status);
    const body = await result.text(); expect(body).not.toContain("PRIVATE"); expect(body).not.toContain("/home");
  });
  it("does not buffer an untrusted error body", async () => {
    const h = harness(); const cancel = vi.fn();
    h.fetch.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 500 }));
    expect((await h.handle(request())).status).toBe(502); expect(cancel).toHaveBeenCalledOnce();
  });
  it("bounds the upstream response bytes and cancels streaming overflow", async () => {
    const h = harness(); const cancel = vi.fn();
    h.fetch.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(262144)); }, cancel,
    })));
    expect((await h.handle(request())).status).toBe(502); expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects an already-cancelled browser request without forwarding", async () => {
    const h = harness(); const abort = new AbortController(); abort.abort();
    expect((await h.handle(request(start, "Bearer user-token", abort.signal))).status).toBe(499);
    expect(h.getUser).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
  });
  it("propagates browser cancellation to the upstream fetch", async () => {
    const h = harness(); const browser = new AbortController();
    let started!: () => void; const startedPromise = new Promise<void>(resolve => { started = resolve; });
    let upstreamSignal: AbortSignal | undefined;
    h.fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      upstreamSignal = init?.signal as AbortSignal;
      upstreamSignal.addEventListener("abort", () => reject(new Error("PRIVATE")), { once: true }); started();
    }));
    const pending = h.handle(request(start, "Bearer user-token", browser.signal));
    await startedPromise; browser.abort();
    expect((await pending).status).toBe(499); expect(upstreamSignal?.aborted).toBe(true);
  });
  it("keeps the upstream deadline active while reading a stalled response body", async () => {
    vi.useFakeTimers(); const h = harness(); const cancel = vi.fn();
    let reading!: () => void; const readingPromise = new Promise<void>(resolve => { reading = resolve; });
    h.fetch.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      pull() { reading(); }, cancel,
    })));
    const pending = h.handle(request());
    await readingPromise; await vi.advanceTimersByTimeAsync(10001);
    const result = await pending;
    expect(result.status).toBe(504); expect(cancel).toHaveBeenCalledOnce();
    expect(await result.text()).toContain("Consulte l’état");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not retry a failed mutation and leak internal exceptions", async () => {
    const h = harness(); h.fetch.mockRejectedValue(new Error("PRIVATE authentication token"));
    const result = await h.handle(request());
    expect(result.status).toBe(502); expect(await result.text()).not.toContain("PRIVATE");
    expect(h.fetch).toHaveBeenCalledOnce();
  });
});
