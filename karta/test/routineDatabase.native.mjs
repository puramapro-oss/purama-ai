#!/usr/bin/env node
/**
 * Real PostgreSQL contention, with two worker connections and one observer.
 * Only a pristine local database named iao_routines_test_* is accepted.
 * Usage: IAO_ROUTINES_NATIVE_DATABASE_URL=postgres://.../iao_routines_test_ci \
 *        node --test test/routineDatabase.native.mjs
 * The CI service owns this disposable database; no provider is contacted.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";

const OWNER = "84000000-0000-4000-8000-000000000001";
const migrationPaths = [
  "../../supabase/migrations/20260122220606_b16f6034-6be4-472b-bc83-57d8767a4721.sql",
  "../migrations/002_karta_global_kill_switch.sql",
  "../migrations/040_iao_routines.sql",
];

function localTestDatabase(raw) {
  let url;
  try { url = new URL(raw ?? ""); } catch { throw new Error("IAO_ROUTINES_NATIVE_DATABASE_URL must name a disposable local test database"); }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !/^iao_routines_test_[a-z0-9_]+$/.test(database) || database.length > 63 ||
      url.search || url.hash || !url.username) {
    throw new Error("Refusing PostgreSQL outside a local iao_routines_test_* database");
  }
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 5432), database,
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), ssl: false,
    connectionTimeoutMillis: 5000, statement_timeout: 8000, lock_timeout: 5000,
    idle_in_transaction_session_timeout: 10000,
  };
}

const config = (patch = {}) => ({
  name: "Native concurrency fixture", instruction: "Fixture only; no external delivery",
  enabled: true, schedule: { kind: "daily", time: "08:30", timezone: "UTC" },
  channels: ["call", "in_app"], deliveryMode: "parallel", agentTypes: [], length: "standard",
  quietHours: null, pausedUntil: null, onlyIfNew: true,
  maxCallMinutes: 2, monthlyCallMinutes: 60, ...patch,
});
const scalar = async (client, sql, args = []) => (await client.query(sql, args)).rows[0].value;
const save = (client, input = config()) => scalar(client,
  "SELECT purama_ai.iao_save_routine($1,$2,0,$3::jsonb) AS value", [OWNER, randomUUID(), JSON.stringify(input)]);
const claim = (client, routine, slot = randomUUID(), scheduled = new Date(Date.now() - 1000).toISOString(), report = { verified: ["initial"] }) => scalar(client,
  "SELECT purama_ai.iao_claim_routine_occurrence($1,$2,$3,$4,$5,$6,$7::jsonb) AS value",
  [OWNER, routine.id, routine.revision, slot, scheduled, new Date(Date.parse(scheduled) + 3600000).toISOString(), JSON.stringify(report)]);
const beginCall = (client, occurrence) => scalar(client,
  "SELECT purama_ai.iao_begin_routine_delivery($1,$2,'call') AS value", [OWNER, occurrence.id]);

test("native fixture refuses remote, ordinary and query-overridden database targets", () => {
  for (const value of [undefined, "postgres://test@db.example/iao_routines_test_ci", "postgres://test@localhost/postgres",
    "postgres://test@localhost/iao_routines_test_ci?host=db.example", "postgres://test@localhost/iao_routines_test_ci/extra"]) {
    assert.throws(() => localTestDatabase(value));
  }
  assert.equal(localTestDatabase("postgres://test@127.0.0.1/iao_routines_test_ci").database, "iao_routines_test_ci");
});

test("routine SQL serializes real PostgreSQL worker connections", { timeout: 60000 }, async t => {
  // Validation happens before constructing or connecting any PostgreSQL client.
  const connection = localTestDatabase(process.env.IAO_ROUTINES_NATIVE_DATABASE_URL);
  const observer = new pg.Client({ ...connection, application_name: "iao-routines-native-observer" });
  const first = new pg.Client({ ...connection, application_name: "iao-routines-native-first" });
  const second = new pg.Client({ ...connection, application_name: "iao-routines-native-second" });
  const clients = [observer, first, second];
  try {
    await observer.connect();
    assert.equal(await scalar(observer, "SELECT current_database() AS value"), connection.database);
    const existing = await scalar(observer, `SELECT (
      to_regnamespace('auth') IS NOT NULL OR to_regnamespace('purama_ai') IS NOT NULL OR
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%') OR
      EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') OR
      EXISTS(SELECT 1 FROM pg_type p JOIN pg_namespace n ON n.oid=p.typnamespace WHERE n.nspname='public')
    ) AS value`);
    assert.equal(existing, false, "Refusing to modify a database that already contains application objects");
    await observer.query(`CREATE SCHEMA auth; CREATE SCHEMA purama_ai;
      CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      DO $$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
      END; $$;
      GRANT USAGE ON SCHEMA auth,purama_ai TO service_role,authenticated,anon;
      CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END; $$;
      CREATE PUBLICATION supabase_realtime;`);
    for (const [index, path] of migrationPaths.entries()) {
      const sql = await readFile(new URL(path, import.meta.url), "utf8");
      await observer.query(sql);
      t.diagnostic(`migration=${path} sha256=${createHash("sha256").update(sql).digest("hex")}`);
      if (index === 0) await observer.query("ALTER TABLE public.notifications SET SCHEMA purama_ai; ALTER TABLE public.notification_preferences SET SCHEMA purama_ai");
    }
    await observer.query("GRANT SELECT,INSERT,UPDATE,DELETE ON purama_ai.notifications,purama_ai.notification_preferences,purama_ai.karta_global_state TO service_role");
    await first.connect(); await second.connect();
    await first.query("SET ROLE service_role"); await second.query("SET ROLE service_role");
    assert.notEqual(first.processID, second.processID);
    t.diagnostic(`worker_pids=${first.processID},${second.processID}; observer_pid=${observer.processID}`);

    async function reset() {
      await observer.query("TRUNCATE auth.users CASCADE; TRUNCATE purama_ai.notifications,purama_ai.notification_preferences; INSERT INTO purama_ai.karta_global_state(id,kill_switch) VALUES('global',false) ON CONFLICT(id) DO UPDATE SET kill_switch=false");
      await observer.query("INSERT INTO auth.users(id) VALUES($1)", [OWNER]);
    }
    async function waitForLock() {
      const deadline = performance.now() + 2000;
      while (performance.now() < deadline) {
        const row = (await observer.query(`SELECT pid,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers
          FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()`, [second.processID])).rows[0];
        if (row?.wait_event_type === "Lock" && row.blockers.includes(first.processID)) return row;
        await delay(20);
      }
      throw new Error("The second PostgreSQL worker was not observed waiting for the first worker's lock within 2 seconds");
    }
    async function race(firstOperation, secondOperation, context) {
      let pending;
      await first.query("BEGIN");
      try {
        const firstResult = await firstOperation(first);
        // Capture both outcomes immediately: a failed contender must never
        // create an unhandled rejection or leave the first transaction open.
        pending = secondOperation(second).then(value => ({ ok: true, value }), error => ({ ok: false, error }));
        const witness = await waitForLock();
        context.diagnostic(`lock_witness=${JSON.stringify(witness)}`);
        await first.query("COMMIT");
        const secondResult = await pending;
        if (!secondResult.ok) throw secondResult.error;
        return { first: firstResult, second: secondResult.value };
      } catch (error) {
        await first.query("ROLLBACK").catch(() => {});
        if (pending) await pending;
        throw error;
      }
    }

    await t.test("the same slot admits one occurrence and one frozen report", async context => {
      await reset(); const routine = await save(first);
      const scheduled = new Date(Date.now() - 1000).toISOString(); const slot = `native:${randomUUID()}`;
      const result = await race(client => claim(client, routine, slot, scheduled),
        client => claim(client, routine, slot, scheduled, { verified: ["later read"] }), context);
      assert.equal(result.first.claimed, true); assert.equal(result.second.claimed, false);
      assert.equal(result.second.reason, "already_claimed");
      assert.equal(result.second.occurrence.id, result.first.occurrence.id);
      assert.deepEqual(result.second.occurrence.report, { verified: ["initial"] });
      assert.equal(await scalar(observer, "SELECT count(*)::int AS value FROM purama_ai.iao_routine_occurrences"), 1);
      assert.equal(await scalar(observer, "SELECT count(*)::int AS value FROM purama_ai.iao_routine_deliveries"), 2);
    });

    await t.test("two routines of one account cannot start two calls", async context => {
      await reset(); const left = await save(first); const right = await save(second);
      const a = (await claim(first, left)).occurrence; const b = (await claim(second, right)).occurrence;
      const result = await race(client => beginCall(client, a), client => beginCall(client, b), context);
      assert.equal(result.first.started, true);
      assert.equal(result.second.started, false); assert.equal(result.second.reason, "call_in_progress");
      assert.equal(await scalar(observer, "SELECT count(*)::int AS value FROM purama_ai.iao_routine_deliveries WHERE channel='call' AND started_at IS NOT NULL"), 1);
      assert.equal(await scalar(observer, "SELECT sum((details->>'reservedMinutes')::int)::int AS value FROM purama_ai.iao_routine_deliveries WHERE channel='call'"), 2);
    });

    await t.test("a closed call still consumes the shared budget before another routine starts", async context => {
      await reset(); const left = await save(first, config({ monthlyCallMinutes: 3 }));
      const right = await save(second, config({ monthlyCallMinutes: 3 }));
      const a = (await claim(first, left)).occurrence; const b = (await claim(second, right)).occurrence;
      const result = await race(async client => {
        assert.equal((await beginCall(client, a)).started, true);
        return scalar(client, "SELECT purama_ai.iao_finish_routine_delivery($1,$2,'call','completed',$3,'{\"answeredBy\":\"human\"}'::jsonb) AS value",
          [OWNER, a.id, `native-receipt-${a.id}`]);
      }, client => beginCall(client, b), context);
      assert.equal(result.first.updated, true); assert.equal(result.first.delivery.status, "completed");
      assert.equal(result.second.started, false); assert.equal(result.second.reason, "call_budget_exhausted");
      assert.equal(await scalar(observer, "SELECT count(*)::int AS value FROM purama_ai.iao_routine_deliveries WHERE channel='call' AND status IN ('sending','accepted','unknown')"), 0);
      assert.equal(await scalar(observer, "SELECT sum((details->>'reservedMinutes')::int)::int AS value FROM purama_ai.iao_routine_deliveries WHERE channel='call'"), 2);
    });

    await t.test("a pause committed before the waiting delivery prevents that delivery", async context => {
      await reset(); const routine = await save(first); const occurrence = (await claim(first, routine)).occurrence;
      const result = await race(client => scalar(client, "SELECT purama_ai.iao_pause_all_routines($1) AS value", [OWNER]),
        client => beginCall(client, occurrence), context);
      assert.deepEqual(result.first, { updatedCount: 1 });
      assert.equal(result.second.started, false); assert.equal(result.second.reason, "stale_revision");
      const stored = (await observer.query("SELECT revision,config->'enabled' AS enabled FROM purama_ai.iao_routines WHERE id=$1", [routine.id])).rows[0];
      assert.deepEqual(stored, { revision: 2, enabled: false });
      assert.equal(await scalar(observer, "SELECT count(*)::int AS value FROM purama_ai.iao_routine_deliveries WHERE started_at IS NOT NULL"), 0);
    });
  } finally {
    // No DROP DATABASE or schema deletion: the disposable CI service owns its
    // lifecycle, and failed fixtures remain available for diagnosis until then.
    await Promise.allSettled(clients.map(client => client.end()));
  }
});
