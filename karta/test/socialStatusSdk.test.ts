import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createSocialStatusTool, type SocialStatusDatabase } from "../src/tools/social-status.js";

const USER = "11111111-1111-4111-8111-111111111111";
const CURSOR = "22222222-2222-4222-8222-222222222221";
const ID = "22222222-2222-4222-8222-222222222222";
const context = { userId: USER, agentType: "maitre-des-publicites", mode: "live" } as const;

describe("social status with the real Supabase SDK and an injected HTTP transport", () => {
  it.each([
    { resource: "accounts", schema: undefined, table: "social_accounts", columns: "id,user_id,platform,is_active,connected_at,publishing_verified_at,disconnect_pending",
      row: { id: ID, user_id: USER, platform: "instagram", is_active: true, connected_at: null, publishing_verified_at: null, disconnect_pending: false } },
    { resource: "posts", schema: "public", table: "social_posts", columns: "id,user_id,status,target_platforms,scheduled_at,published_at,created_at,updated_at,zernio_post_id",
      row: { id: ID, user_id: USER, status: "publish_unconfirmed", target_platforms: ["instagram"], scheduled_at: null, published_at: null, created_at: null, updated_at: null, zernio_post_id: "post_fixture" } },
  ] as const)("queries the selected schema and owner for $resource", async ({ resource, schema, table, columns, row }) => {
    const requests: Request[] = [];
    const client = createClient("https://social-status.invalid", "test-only-sdk-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify([{ ...row, metadata: "PRIVATE_ROW_CANARY" }]), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      } },
    });
    const tool = createSocialStatusTool({ database: client as unknown as SocialStatusDatabase, schema: () => schema });
    const result = await tool.execute({ resource, limit: 10, afterId: CURSOR }, context);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const url = new URL(request.url);
    expect(request.method).toBe("GET");
    expect(url.origin).toBe("https://social-status.invalid");
    expect(url.pathname).toBe(`/rest/v1/${table}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      select: columns, user_id: `eq.${USER}`, order: "id.asc", id: `gt.${CURSOR}`, limit: "11",
    });
    expect(request.headers.get("Accept-Profile")).toBe(schema ?? "purama_ai");
    expect(result).toMatchObject({
      status: "read", source: "stored_social_metadata", providerHealth: "not_checked",
      liveProviderCheckPerformed: false, publicationPerformed: false,
      page: { limit: 10, hasMore: false, nextAfterId: null },
    });
    expect(result.items).toHaveLength(1);
    if (resource === "posts") expect(result.items[0]).toMatchObject({ status: "publish_unconfirmed" });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_ROW_CANARY|test-only-sdk-key/);
  });

  it("keeps an SDK HTTP error private and does not retry in another schema", async () => {
    let calls = 0;
    const client = createClient("https://social-status.invalid", "test-only-sdk-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async () => {
        calls++;
        return new Response(JSON.stringify({ message: "PRIVATE_DATABASE_CANARY", code: "42P01" }), {
          status: 404, headers: { "Content-Type": "application/json" },
        });
      } },
    });
    const tool = createSocialStatusTool({ database: client as unknown as SocialStatusDatabase, schema: () => undefined });
    await expect(tool.execute({ resource: "accounts" }, context)).rejects.toThrow(/^Lecture de l’état social indisponible\.$/);
    expect(calls).toBe(1);
  });
});
