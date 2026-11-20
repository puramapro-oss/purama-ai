import { beforeEach, expect, it, vi } from "vitest";
import { loadAgentState } from "../src/engine/autonomy.js";

const db = vi.hoisted(() => ({ read: vi.fn(), readWinner: vi.fn(), insert: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({ supabase: {
  from: (table: string) => {
    if (table !== "karta_agent_state") throw new Error("unexpected table");
    return {
      select: () => ({ eq: (first: string, user: string) => ({ eq: (second: string, agent: string) => {
        if (first !== "user_id" || second !== "agent_type") throw new Error("missing state scope");
        return { maybeSingle: () => db.read(user, agent), single: () => db.readWinner(user, agent) };
      } }) }),
      insert: (key: { user_id: string; agent_type: string }) => ({ select: () => ({ single: () => db.insert(key) }) }),
    };
  },
} }));

const missing = { data: null, error: null };
const winner = { is_enabled: false, autonomy_level: 2, kill_switch: true, simulation_mode: false };
const conflict = { data: null, error: { code: "23505", message: "unique constraint" } };
beforeEach(() => { vi.resetAllMocks(); });

it("returns the same stored state to two callers that both observed an empty row", async () => {
  let release!: () => void;
  const bothRead = new Promise<void>(resolve => { release = resolve; });
  let readers = 0;
  db.read.mockImplementation(async () => {
    if (++readers === 2) release();
    await bothRead;
    return missing;
  });
  db.insert.mockResolvedValueOnce({ data: winner, error: null }).mockResolvedValueOnce(conflict);
  db.readWinner.mockResolvedValue({ data: winner, error: null });

  const results = await Promise.all([loadAgentState("owner", "email"), loadAgentState("owner", "email")]);
  const expected = { userId: "owner", agentType: "email", isEnabled: false, autonomyLevel: 2, killSwitch: true, simulationMode: false };
  expect(results).toEqual([expected, expected]);
  expect(db.insert.mock.calls).toEqual([[{ user_id: "owner", agent_type: "email" }], [{ user_id: "owner", agent_type: "email" }]]);
  expect(db.readWinner.mock.calls).toEqual([["owner", "email"]]);
});

it("preserves unrelated insert errors without repeating the write", async () => {
  db.read.mockResolvedValue(missing);
  db.insert.mockResolvedValue({ data: null, error: { code: "42501", message: "access denied" } });
  await expect(loadAgentState("owner", "email")).rejects.toThrow("access denied");
  expect(db.insert).toHaveBeenCalledOnce();
  expect(db.readWinner).not.toHaveBeenCalled();
});

it.each([missing, { data: null, error: { message: "read failed" } }])("fails closed if the winning row cannot be read", async result => {
  db.read.mockResolvedValue(missing);
  db.insert.mockResolvedValue(conflict);
  db.readWinner.mockResolvedValue(result);
  await expect(loadAgentState("owner", "email")).rejects.toThrow(/23505/);
  expect(db.readWinner.mock.calls).toEqual([["owner", "email"]]);
  expect(db.insert).toHaveBeenCalledOnce();
});
