import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../src/engine/types.js";
import type { SocialStatusDatabase, SocialStatusDbResult, SocialStatusParams, SocialStatusQuery } from "../src/tools/social-status.js";

const production = vi.hoisted(() => ({ schema: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({ supabase: production }));
const { createSocialStatusTool, socialStatusTool } = await import("../src/tools/social-status.js");

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const IDS = [
  "10000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  "30000000-0000-4000-8000-000000000003",
];
const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const PRIVATE = "PRIVATE_DATABASE_CREDENTIAL_OR_CONTENT_MUST_NOT_ESCAPE";
const ctx: ToolExecutionContext = { userId: USER, agentType: "maitre-des-publicites", mode: "live" };
type Row = Record<string, unknown>;
type Call = { table: string; schema: string; operations: Array<[string, ...unknown[]]>; started: number; signal?: AbortSignal };

function account(id = IDS[0]!, platform = "instagram"): Row {
  return { id, user_id: USER, platform, is_active: true, disconnect_pending: false,
    connected_at: "2026-11-20T10:00:00+00:00", publishing_verified_at: "2026-11-20T10:00:01.123456+00:00" };
}
function post(id = IDS[0]!, status = "published"): Row {
  return { id, user_id: USER, status, target_platforms: ["instagram", "linkedin"],
    scheduled_at: null, published_at: "2026-11-21T10:01:00Z", created_at: "2026-11-21T10:00:00Z",
    updated_at: "2026-11-21T10:01:00Z", zernio_post_id: "65f1c0a9e2b5af0012ab34cd" };
}
function fixture(rows: unknown = []) {
  const calls: Call[] = [];
  const reply = vi.fn<() => Promise<SocialStatusDbResult>>().mockResolvedValue({ data: rows, error: null });
  const selectSchema = vi.fn<SocialStatusDatabase["schema"]>(selected => ({
    from(table) {
      const call: Call = { table, schema: selected, operations: [], started: 0 }; calls.push(call);
      const query: SocialStatusQuery = {
        select(columns) { call.operations.push(["select", columns]); return query; },
        eq(column, value) { call.operations.push(["eq", column, value]); return query; },
        order(column, options) { call.operations.push(["order", column, options]); return query; },
        gt(column, value) { call.operations.push(["gt", column, value]); return query; },
        limit(value) { call.operations.push(["limit", value]); return query; },
        abortSignal(signal) { call.signal = signal; return query; },
        then(resolve, reject) { call.started++; return reply().then(resolve, reject); },
      };
      return query;
    },
  }));
  const database: SocialStatusDatabase = { schema: selectSchema };
  return { calls, reply, selectSchema, database,
    tool: (options: { schema?: () => unknown; timeoutMs?: number } = {}) => createSocialStatusTool({ database, now: () => NOW, ...options }),
  };
}

beforeEach(() => {
  production.schema.mockReset().mockImplementation(() => { throw new Error("Unexpected production database access"); });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Provider network access forbidden in social status tests"); }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("social_status reads only stored metadata for the current owner", () => {
  it("selects a fixed account projection and preserves the limits of local evidence", async () => {
    const f = fixture([account()]);
    const result = await f.tool().execute({ resource: "accounts" }, ctx);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ schema: "purama_ai", table: "social_accounts", started: 1,
      operations: [
        ["select", "id,user_id,platform,is_active,connected_at,publishing_verified_at,disconnect_pending"],
        ["eq", "user_id", USER], ["order", "id", { ascending: true }], ["limit", 11],
      ] });
    expect(result).toEqual({
      status: "read", source: "stored_social_metadata", providerHealth: "not_checked",
      liveProviderCheckPerformed: false, publicationPerformed: false, observedAt: "2026-11-22T12:00:00.000Z",
      resource: "accounts", items: [{ accountId: IDS[0], platform: "instagram", active: true,
        disconnectPending: false, connectedAt: "2026-11-20T10:00:00+00:00", associationRecordedAt: "2026-11-20T10:00:01.123456+00:00" }],
      page: { limit: 10, hasMore: false, nextAfterId: null },
    });
    expect(f.calls[0]!.signal?.aborted).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads publication states and identifiers without private content or raw provider JSON", async () => {
    const f = fixture([{ ...post(), content_text: PRIVATE, content_media_urls: [PRIVATE], ai_caption: PRIVATE,
      zernio_response: { token: PRIVATE }, platform_results: [{ error: PRIVATE }], error_message: PRIVATE, metadata: { secret: PRIVATE } }]);
    const result = await f.tool().execute({ resource: "posts" }, ctx);
    expect(f.calls[0]!.table).toBe("social_posts");
    expect(f.calls[0]!.operations[0]).toEqual(["select", "id,user_id,status,target_platforms,scheduled_at,published_at,created_at,updated_at,zernio_post_id"]);
    expect(result.items).toEqual([{ postId: IDS[0], status: "published", targetPlatforms: ["instagram", "linkedin"],
      scheduledAt: null, publishedAt: "2026-11-21T10:01:00Z", createdAt: "2026-11-21T10:00:00Z", updatedAt: "2026-11-21T10:01:00Z",
      providerPostId: "65f1c0a9e2b5af0012ab34cd" }]);
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    expect(JSON.stringify(result)).not.toContain(USER);
    expect(result.providerHealth).toBe("not_checked");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps nullable legacy account fields unknown and an unverified binding unverified", async () => {
    const f = fixture([{ ...account(), is_active: null, connected_at: null, publishing_verified_at: null, disconnect_pending: true }]);
    const result = await f.tool().execute({ resource: "accounts" }, ctx);
    expect(result.items[0]).toMatchObject({ active: null, connectedAt: null, associationRecordedAt: null, disconnectPending: true });
    expect(result.items[0]).not.toHaveProperty("canPost");
    expect(result.items[0]).not.toHaveProperty("healthy");
  });

  it.each(["draft", "scheduled", "publishing", "partial", "failed", "publish_unconfirmed"])("reports stored %s without granting a retry or fabricating a receipt", async status => {
    const f = fixture([{ ...post(IDS[0], status), published_at: null, zernio_post_id: null }]);
    const result = await f.tool().execute({ resource: "posts" }, ctx);
    expect(result.items[0]).toMatchObject({ status, publishedAt: null, providerPostId: null });
    expect(result).toMatchObject({ liveProviderCheckPerformed: false, publicationPerformed: false });
    expect(result.items[0]).not.toHaveProperty("retryable");
  });

  it("validates the nullable dates and empty targets allowed on a legacy draft", async () => {
    const f = fixture([{ ...post(IDS[0], "draft"), target_platforms: [], published_at: null, created_at: null, updated_at: null, zernio_post_id: null }]);
    const result = await f.tool().execute({ resource: "posts" }, ctx);
    expect(result.items[0]).toMatchObject({ targetPlatforms: [], createdAt: null, updatedAt: null });
  });

  it("protects the trace and disallows dynamic parameters", () => {
    expect(socialStatusTool.tracePolicy).toBe("metadata_only");
    expect(socialStatusTool.sensitive).toBe(false);
    expect(socialStatusTool.inputSchema).toMatchObject({ additionalProperties: false, required: ["resource"] });
  });
});

describe("authority and schema selection", () => {
  it.each(["email", "compta", "custom:00000000-0000-4000-8000-000000000001"])("does not expose the read to %s", async agentType => {
    const f = fixture([account()]);
    await expect(f.tool().execute({ resource: "accounts" }, { ...ctx, agentType } as ToolExecutionContext)).rejects.toThrow("Lecture sociale non autorisée.");
    expect(f.selectSchema).not.toHaveBeenCalled();
  });

  it.each(["", "not-a-uuid", USER + "\n"])("rejects an invalid owner without touching the database: %j", async userId => {
    const f = fixture([account()]);
    await expect(f.tool().execute({ resource: "accounts" }, { ...ctx, userId })).rejects.toThrow("Lecture sociale non autorisée.");
    expect(f.selectSchema).not.toHaveBeenCalled();
  });

  it("does not query or fabricate evidence in simulation", async () => {
    const f = fixture([account()]); const schema = vi.fn(() => { throw new Error(PRIVATE); });
    const result = await f.tool({ schema }).execute({ resource: "accounts", limit: 2 }, { ...ctx, mode: "simulation" });
    expect(result).toMatchObject({ status: "simulated", observedAt: null, items: [], providerHealth: "not_checked" });
    expect(schema).not.toHaveBeenCalled();
    expect(f.selectSchema).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the explicit public setting on the existing client, without also querying purama_ai", async () => {
    const f = fixture([]);
    await f.tool({ schema: () => "public" }).execute({ resource: "posts" }, ctx);
    expect(f.selectSchema.mock.calls).toEqual([["public"]]);
  });

  it("reads SOCIAL_DB_SCHEMA at execution from the server environment", async () => {
    const f = fixture([]); production.schema.mockImplementation(f.database.schema);
    vi.stubEnv("SOCIAL_DB_SCHEMA", "public");
    await socialStatusTool.execute({ resource: "accounts" }, ctx);
    expect(production.schema.mock.calls).toEqual([["public"]]);
  });

  it.each(["", "PUBLIC", "auth", " public", null])("rejects the invalid server schema %j with no fallback", async selected => {
    const f = fixture([]);
    await expect(f.tool({ schema: () => selected }).execute({ resource: "accounts" }, ctx)).rejects.toThrow("Lecture de l’état social indisponible.");
    expect(f.selectSchema).not.toHaveBeenCalled();
  });

  it.each(["42P01", "42703", "PGRST205"])("does not retry another schema when a required capability is unavailable: %s", async code => {
    const f = fixture([]); f.reply.mockResolvedValue({ data: null, error: { code, message: PRIVATE, details: PRIVATE } });
    await expect(f.tool({ schema: () => "public" }).execute({ resource: "accounts" }, ctx)).rejects.toThrow("Lecture de l’état social indisponible.");
    expect(f.selectSchema.mock.calls).toEqual([["public"]]);
    expect(f.reply).toHaveBeenCalledTimes(1);
  });
});

describe("input, row validation and pagination", () => {
  it.each([
    null, [], {}, { resource: "secrets" }, { resource: "accounts", userId: OTHER },
    { resource: "accounts", schema: "public" }, { resource: "posts", columns: "*" },
    { resource: "posts", limit: 0 }, { resource: "posts", limit: 21 },
    { resource: "posts", limit: 1.5 }, { resource: "posts", limit: "1" },
    { resource: "posts", afterId: "id.gt.0,or(user_id.eq.other)" },
  ])("rejects inadmissible parameters before SQL: %j", async input => {
    const f = fixture([]);
    await expect(f.tool().execute(input as SocialStatusParams, ctx)).rejects.toThrow("Paramètres de lecture sociale invalides.");
    expect(f.selectSchema).not.toHaveBeenCalled();
  });

  it("uses the last returned ID as cursor, checks the sentinel and closes a terminal page", async () => {
    const f = fixture([post(IDS[0]), post(IDS[1]), post(IDS[2])]);
    const first = await f.tool().execute({ resource: "posts", limit: 2 }, ctx);
    expect(first.items).toHaveLength(2);
    expect(first.page).toEqual({ limit: 2, hasMore: true, nextAfterId: IDS[1] });
    expect(f.calls[0]!.operations).toContainEqual(["limit", 3]);
    f.reply.mockResolvedValue({ data: [post(IDS[2])], error: null });
    const second = await f.tool().execute({ resource: "posts", limit: 2, afterId: first.page.nextAfterId! }, ctx);
    expect(second.page).toEqual({ limit: 2, hasMore: false, nextAfterId: null });
    expect(f.calls[1]!.operations).toContainEqual(["gt", "id", IDS[1]]);
    expect(f.calls[1]!.operations).toContainEqual(["eq", "user_id", USER]);
  });

  it("returns a proven empty page only after a successful scoped read", async () => {
    const f = fixture([]);
    const result = await f.tool().execute({ resource: "posts" }, ctx);
    expect(result).toMatchObject({ status: "read", items: [], page: { hasMore: false, nextAfterId: null } });
    expect(f.reply).toHaveBeenCalledOnce();
  });

  it.each([0, 1])("rejects another owner's row, including the sentinel at position %s", async position => {
    const rows = [post(IDS[0]), post(IDS[1])]; rows[position]!.user_id = OTHER;
    const f = fixture(rows);
    await expect(f.tool().execute({ resource: "posts", limit: 1 }, ctx)).rejects.toThrow("Lecture de l’état social indisponible.");
  });

  it.each([
    null, {}, [null], [post(IDS[1]), post(IDS[0])], [post(IDS[0]), post(IDS[0])],
    [post(IDS[0]), post(IDS[1]), post(IDS[2])],
  ])("rejects malformed, duplicate, unordered or excessive data: %j", async rows => {
    const f = fixture(rows);
    await expect(f.tool().execute({ resource: "posts", limit: 1 }, ctx)).rejects.toThrow("Lecture de l’état social indisponible.");
  });

  it("rejects a database result that ignored the cursor", async () => {
    const f = fixture([post(IDS[0])]);
    await expect(f.tool().execute({ resource: "posts", afterId: IDS[1] }, ctx)).rejects.toThrow("Lecture de l’état social indisponible.");
  });

  it.each([
    { is_active: "true" }, { disconnect_pending: "false" }, { disconnect_pending: undefined },
    { platform: "unknown-network" }, { connected_at: "2026-02-30T12:00:00Z" },
    { publishing_verified_at: "2026-11-20T10:00:00Z\n" },
  ])("rejects incompatible account metadata: %j", async patch => {
    const f = fixture([{ ...account(), ...patch }]);
    await expect(f.tool().execute({ resource: "accounts" }, ctx)).rejects.toThrow("Lecture de l’état social indisponible.");
  });

  it("rejects duplicate account platforms despite distinct local IDs", async () => {
    const f = fixture([account(IDS[0]), account(IDS[1])]);
    await expect(f.tool().execute({ resource: "accounts" }, ctx)).rejects.toThrow("Lecture de l’état social indisponible.");
  });

  it.each([
    { status: "successful" }, { target_platforms: ["instagram", "instagram"] },
    { target_platforms: ["unknown"] }, { zernio_post_id: "https://example.invalid/?secret=" + PRIVATE },
    { zernio_post_id: "x".repeat(257) }, { updated_at: undefined },
  ])("rejects incompatible receipt metadata without reflecting the value: %j", async patch => {
    const f = fixture([{ ...post(), ...patch }]);
    await expect(f.tool().execute({ resource: "posts" }, ctx)).rejects.toThrow("Lecture de l’état social indisponible.");
  });

  it("does not reflect private query rejection details", async () => {
    const f = fixture([]); f.reply.mockRejectedValue(new Error(PRIVATE));
    const error = await f.tool().execute({ resource: "accounts" }, ctx).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(PRIVATE);
    expect(String(error)).toContain("Lecture de l’état social indisponible.");
    expect(f.calls[0]!.signal?.aborted).toBe(true);
  });
});

describe("bounded database transport", () => {
  it("settles an uncooperative query and aborts its transport", async () => {
    vi.useFakeTimers();
    const f = fixture([]); f.reply.mockImplementation(() => new Promise(() => {}));
    const outcome = f.tool({ timeoutMs: 25 }).execute({ resource: "posts" }, ctx).then(() => "unexpected", error => (error as Error).message);
    await vi.advanceTimersByTimeAsync(26);
    expect(await outcome).toBe("Lecture de l’état social indisponible.");
    expect(f.calls[0]!.signal?.aborted).toBe(true);
    expect(f.reply).toHaveBeenCalledOnce();
  });

  it("does not accept a late page after expiration", async () => {
    vi.useFakeTimers();
    let finish!: (value: SocialStatusDbResult) => void;
    const late = new Promise<SocialStatusDbResult>(resolve => { finish = resolve; });
    const f = fixture([]); f.reply.mockReturnValue(late);
    let successes = 0;
    const outcome = f.tool({ timeoutMs: 25 }).execute({ resource: "accounts" }, ctx)
      .then(() => { successes++; return "unexpected"; }, error => (error as Error).message);
    await vi.advanceTimersByTimeAsync(26);
    expect(await outcome).toBe("Lecture de l’état social indisponible.");
    finish({ data: [account()], error: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(successes).toBe(0);
    expect(f.reply).toHaveBeenCalledOnce();
  });

  it("checks the monotonic deadline even before a delayed timer callback", async () => {
    let monotonic = 0; vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const f = fixture([]); f.reply.mockImplementation(async () => { monotonic = 26; return { data: [post()], error: null }; });
    await expect(f.tool({ timeoutMs: 25 }).execute({ resource: "posts" }, ctx)).rejects.toThrow("Lecture de l’état social indisponible.");
    expect(f.calls[0]!.signal?.aborted).toBe(true);
  });
});
