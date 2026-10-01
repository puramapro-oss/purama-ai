import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  mutations: [] as Array<{ kind: string; row: Record<string, unknown>; filters: Record<string, unknown> }>,
  from: vi.fn(),
}));

vi.mock("../src/db/supabase.js", () => ({ supabase: { from: state.from } }));
const { supabaseUpsertTool } = await import("../src/tools/supabase-tool.js");
const ctx = { userId: "owner-a", agentType: "legal" as const, mode: "live" as const };

beforeEach(() => {
  vi.clearAllMocks();
  state.rows.clear();
  state.rows.set("a", { id: "a", user_id: "owner-a", title: "Original A" });
  state.rows.set("b", { id: "b", user_id: "owner-b", title: "Original B" });
  state.mutations.length = 0;
  state.from.mockImplementation(() => {
    const mutation = { kind: "", row: {} as Record<string, unknown>, filters: {} as Record<string, unknown> };
    const builder = {
      insert(row: Record<string, unknown>) { mutation.kind = "insert"; mutation.row = row; return builder; },
      update(row: Record<string, unknown>) { mutation.kind = "update"; mutation.row = row; return builder; },
      eq(key: string, value: unknown) { mutation.filters[key] = value; return builder; },
      select() { return builder; },
      async maybeSingle() {
        state.mutations.push(mutation);
        if (mutation.kind === "insert") {
          const row = { ...mutation.row, id: "new-id" };
          state.rows.set(row.id, row);
          return { data: { id: row.id }, error: null };
        }
        const existing = [...state.rows.values()].find((row) => Object.entries(mutation.filters).every(([key, value]) => row[key] === value));
        if (!existing) return { data: null, error: null };
        const id = String(existing.id);
        state.rows.set(id, { ...existing, ...mutation.row });
        return { data: { id }, error: null };
      },
    };
    return builder;
  });
});

describe("supabase_upsert owner-scoped writes", () => {
  it("updates an owned row with both predicates and cannot change its owner", async () => {
    await expect(supabaseUpsertTool.execute({ table: "legal_documents", row: { id: "a", title: "Updated", user_id: "owner-b" } }, ctx)).resolves.toEqual({ id: "a" });
    expect(state.mutations[0]).toEqual({ kind: "update", row: { title: "Updated", user_id: "owner-a" }, filters: { id: "a", user_id: "owner-a" } });
    expect(state.rows.get("a")).toEqual({ id: "a", user_id: "owner-a", title: "Updated" });
  });

  it("does not take over another user's row and does not fall back to insert", async () => {
    await expect(supabaseUpsertTool.execute({ table: "legal_documents", row: { id: "b", title: "Attack" } }, ctx)).rejects.toThrow(/aucune ligne autorisée/);
    expect(state.rows.get("b")).toEqual({ id: "b", user_id: "owner-b", title: "Original B" });
    expect(state.mutations).toHaveLength(1);
    expect(state.mutations[0].kind).toBe("update");
  });

  it("does not reveal whether an inaccessible id exists", async () => {
    const messages: string[] = [];
    for (const id of ["b", "missing"]) {
      await supabaseUpsertTool.execute({ table: "legal_documents", row: { id, title: "Test" } }, ctx).catch((error: Error) => messages.push(error.message));
    }
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(messages[1]);
  });

  it("inserts new rows without a model-chosen id and forces the authenticated owner", async () => {
    await expect(supabaseUpsertTool.execute({ table: "legal_documents", row: { title: "New", user_id: "owner-b" } }, ctx)).resolves.toEqual({ id: "new-id" });
    expect(state.mutations[0]).toEqual({ kind: "insert", row: { title: "New", user_id: "owner-a" }, filters: {} });
    expect(state.rows.get("new-id")?.user_id).toBe("owner-a");
  });

  it.each([null, 12, {}, "", "   "])("rejects invalid explicit ids before database access: %s", async (id) => {
    await expect(supabaseUpsertTool.execute({ table: "legal_documents", row: { id, title: "Test" } }, ctx)).rejects.toThrow(/identifiant texte/);
    expect(state.from).not.toHaveBeenCalled();
  });
});
