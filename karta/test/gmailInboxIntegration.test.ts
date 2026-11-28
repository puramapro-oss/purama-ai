import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const client = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({ supabase: client }));
vi.mock("../src/config.js", () => ({ config: {} }));
vi.mock("../src/lib/gmail-token-crypto.js", () => ({ decryptGmailToken: (v: string) => v, encryptGmailToken: (v: string) => v }));
import { prepareGmailInboxCycle } from "../src/tools/gmail-inbox-cycle.js";
import { gmailCreateDraftTool } from "../src/tools/gmail.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const user = randomUUID(), email = "receiver@example.invalid", sender = "issuer@example.invalid";
const ref = { id: "source1", threadId: "thread1" }, params = { threadId: ref.threadId, replyToMessageId: ref.id, to: sender, subject: "Facture test", body: "Merci de préciser le montant." };
let db: PGlite;
let posted: number, reads: string[], losePost: boolean;
const msg = { ...ref, snippet: "Aperçu", payload: { mimeType: "text/plain",
  headers: [{ name: "From", value: sender }, { name: "Subject", value: params.subject }, { name: "Message-ID", value: "<source1@example.invalid>" }],
  body: { data: Buffer.from("Une question").toString("base64url"), size: 12 } } };
const rpcNames = new Set(["gmail_inbox_claim", "gmail_inbox_capture", "gmail_inbox_begin", "gmail_inbox_finish"]);
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE SQL AS
    $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`);
  await db.query("INSERT INTO auth.users VALUES($1)", [user]);
  for (const path of ["../../supabase/migrations/20260406210000_email_agent.sql", "../migrations/001_karta_core.sql",
    "../migrations/005_karta_pending_actions.sql", "../migrations/006_execution_claims.sql", "../../supabase/migrations/20261128010000_gmail_inbox_receipts.sql"]) await db.exec(read(path));
  // Emulate only PostgREST wire conversion, with every claim/policy check executed by PostgreSQL.
  client.from.mockImplementation((table: string) => {
    if (table !== "email_agent_config") throw new Error("Unexpected table");
    const where: Record<string, unknown> = {};
    let fields: string[];
    return {
      select(names: string) { fields = names.split(","); return this; },
      eq(name: string, value: unknown) { where[name] = value; return this; },
      abortSignal() { return this; },
      async maybeSingle() {
        const values = Object.entries(where);
        const query = await db.query<{ row: Record<string, unknown> }>(
          `SELECT to_jsonb(c) row FROM purama_ai.email_agent_config c WHERE ${values.map(([key], i) => {
            if (!/^[a-z_]+$/.test(key)) throw new Error("Invalid fixture column"); return `${key}=$${i + 1}`;
          }).join(" AND ")}`, values.map(([, value]) => value));
        const row = query.rows[0]?.row;
        return { data: row ? Object.fromEntries(fields.map(key => [key, row[key]])) : null, error: null };
      },
    };
  });
  client.rpc.mockImplementation((name: string, input: Record<string, unknown>) => ({
    async abortSignal() {
      if (!rpcNames.has(name)) throw new Error("Unexpected function");
      const values = Object.entries(input);
      const result = await db.query<{ v: unknown }>(`SELECT purama_ai.${name}(${values.map(([key], i) => {
        if (!/^p_[a-z_]+$/.test(key)) throw new Error("Invalid fixture argument"); return `${key} => $${i + 1}`;
      }).join(",")}) v`, values.map(([key, value]) => key === "p_messages" ? JSON.stringify(value) : value));
      return { data: result.rows[0]?.v, error: null };
    },
  }));
}, 30000);
beforeEach(async () => {
  posted = 0; reads = []; losePost = false;
  await db.exec("TRUNCATE purama_ai.gmail_inbox_items,purama_ai.email_agent_config,purama_ai.karta_runs CASCADE;");
  await db.query(`INSERT INTO purama_ai.email_agent_config(user_id,gmail_email,is_active,gmail_access_token,gmail_refresh_token,gmail_token_expiry)
    VALUES ($1,$2,true,'token-fixture','refresh-fixture',clock_timestamp()+interval '1 hour')`, [user,email]);
  vi.stubGlobal("fetch", vi.fn(async (raw: string, options: RequestInit) => {
    const url = new URL(raw);
    if (url.hostname !== "gmail.googleapis.com") throw new Error("Unrecognised fixture endpoint");
    expect((options.headers as Record<string,string>).Authorization).toBe("Bearer token-fixture");
    if (url.pathname.endsWith("/drafts")) {
      posted++;
      if (losePost) throw new Error("Fixture provider timed out after write");
      return Response.json({ id: "draft123" });
    }
    reads.push(url.search);
    return Response.json(url.pathname.endsWith("/messages") ? { messages: [ref] } : msg);
  }));
});
afterAll(async () => { vi.unstubAllGlobals(); await db.close(); });
async function run(role: "email" | "repondeur-intelligent" = "email") {
  const id = randomUUID();
  await db.query("INSERT INTO purama_ai.karta_runs(id,user_id,agent_type,trigger_type,mode) VALUES($1,$2,$3,'cron','live')", [id,user,role]);
  return prepareGmailInboxCycle(user,role,id,"live");
}
const status = () => db.query<{state: string; reference: string|null}>("SELECT state,reference FROM purama_ai.gmail_inbox_items");
describe("Gmail API adapter into durable PostgreSQL receipts", () => {
  it("captures once across both agents and records the provider draft receipt against the source", async () => {
    const inbox = await run();
    expect(inbox.hasMessage).toBe(true);
    const competing = await run("repondeur-intelligent");
    expect(competing.hasMessage).toBe(false);
    await inbox.beforeInference(); await inbox.beforeEffect("gmail_create_draft", params, "execute");
    const result = await gmailCreateDraftTool.execute(params, { userId: user, agentType: "email", mode: "live", gmailInboxBinding: inbox.binding });
    await inbox.finish("done", `draft:${result.draftId}`);
    expect((await status()).rows).toEqual([{state: "done", reference: "draft:draft123"}]);
    expect((await run()).hasMessage).toBe(false); expect(posted).toBe(1);
  });
  it("preserves the first receipt and the remaining action for the owner", async () => {
    const inbox = await run();
    await inbox.beforeEffect("gmail_create_draft", params, "execute", ["send_notification"]);
    const result = await gmailCreateDraftTool.execute(params, { userId:user, agentType:"email", mode:"live", gmailInboxBinding:inbox.binding });
    await inbox.finish("done", `draft:${result.draftId}`);
    const pending = await db.query("SELECT state,reference,followup_tools FROM purama_ai.gmail_inbox_items");
    expect(pending.rows[0]).toEqual({state:"followup",reference:"draft:draft123",followup_tools:["send_notification"]});
    expect((await run("repondeur-intelligent")).hasMessage).toBe(false);
    expect(posted).toBe(1);
  });
  it("preserves an unknown provider result across redelivery without a second provider write", async () => {
    const inbox = await run(); await inbox.beforeEffect("gmail_create_draft", params, "execute"); losePost = true;
    await expect(gmailCreateDraftTool.execute(params, { userId: user, agentType: "email", mode: "live", gmailInboxBinding: inbox.binding })).rejects.toThrow(/non confirmé/);
    await inbox.finish("review");
    expect((await status()).rows[0]?.state).toBe("review");
    expect((await run("repondeur-intelligent")).hasMessage).toBe(false);
    expect(posted).toBe(1);
  });
  it("does not retrieve the body of an excluded sender", async () => {
    await db.query("UPDATE purama_ai.email_agent_config SET excluded_emails=ARRAY[$1] WHERE user_id=$2", [sender,user]);
    expect((await run()).hasMessage).toBe(false);
    expect((await status()).rows[0]?.state).toBe("ignored");
    expect(reads.some(query => query.includes("format=full"))).toBe(false); expect(posted).toBe(0);
  });
  it("rejects a mailbox change between arming and provider departure, with no outgoing write", async () => {
    const inbox = await run(); await inbox.beforeEffect("gmail_create_draft", params, "execute");
    await db.query("UPDATE purama_ai.email_agent_config SET gmail_email='other@example.invalid' WHERE user_id=$1", [user]);
    await expect(gmailCreateDraftTool.execute(params, { userId:user, agentType:"email", mode:"live", gmailInboxBinding:inbox.binding })).rejects.toThrow(/autorisation/);
    expect(posted).toBe(0);
  });
});
