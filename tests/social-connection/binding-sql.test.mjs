import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Runs the actual migrations against PostgreSQL/WASM. The test runtime is
// external to the app manifest; no network or provider account is involved.
const { PGlite } = await import(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const migration = (name) => readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8");
const [base, publication, binding] = await Promise.all([
  migration("20260406120000_social_autopilot.sql"),
  migration("20261110000300_social_publish_idempotency.sql"),
  migration("20261110000400_social_account_binding.sql"),
]);
const schemas = ["public", "purama_ai"];
const legacyUser = randomUUID();
let db;
let serial = 0;
const providerId = () => (++serial).toString(16).padStart(24, "0");
const stateHash = () => (++serial).toString(16).padStart(64, "0");

before(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA purama_ai;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA public, purama_ai, auth TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
  `);
  await db.exec(base);
  await db.exec(base.replaceAll("public.", "purama_ai."));
  await db.query("INSERT INTO auth.users VALUES ($1)", [legacyUser]);
  for (const s of schemas) {
    // Simulate broad old grants so the revocations must actually remove them.
    await db.exec(`GRANT ALL ON ALL TABLES IN SCHEMA ${s} TO anon, authenticated;
      GRANT UPDATE (zernio_account_id) ON ${s}.social_accounts TO authenticated;`);
    await db.query(`INSERT INTO ${s}.social_accounts
      (user_id, platform, zernio_account_id, zernio_profile_id, account_name)
      VALUES ($1, 'youtube', 'legacy-account', 'legacy-profile', 'Untested legacy account')`, [legacyUser]);
  }
  await db.exec(publication);
  await db.exec(binding);
});
after(async () => { await db?.close(); });

async function asRole(role, work) {
  assert(["anon", "authenticated", "service_role"].includes(role));
  await db.exec(`SET ROLE ${role}`);
  try { return await work(); } finally { await db.exec("RESET ROLE"); }
}
async function newProfile(s) {
  const user = randomUUID();
  await db.query("INSERT INTO auth.users VALUES ($1)", [user]);
  const row = (await asRole("service_role", () => db.query(
    `SELECT ${s}.social_get_or_create_profile_binding($1) AS value`, [user],
  ))).rows[0].value;
  return { user, row };
}
async function readyProfile(s) {
  const f = await newProfile(s);
  f.profile = providerId();
  await asRole("service_role", () => db.query(
    `SELECT ${s}.social_finish_profile_binding($1, $2)`, [f.row.id, f.profile],
  ));
  return f;
}
async function begin(s, f, overrides = {}) {
  const value = { hash: stateHash(), nonce: randomUUID(), platform: "youtube", ...overrides };
  await asRole("service_role", () => db.query(
    `SELECT ${s}.social_begin_connection($1, $2, $3, $4, $5,
      date_trunc('second', clock_timestamp()), date_trunc('second', clock_timestamp()) + interval '10 minutes')`,
    [f.user, value.platform, f.profile, value.hash, value.nonce],
  ));
  return value;
}
async function finish(s, f, intent, account = providerId()) {
  return (await asRole("service_role", () => db.query(
    `SELECT ${s}.social_finish_connection($1, $2, $3, $4, $5, 'Verified provider name', 'provider-user') AS value`,
    [intent.hash, f.user, intent.platform, f.profile, account],
  ))).rows[0].value;
}
async function accountRow(s, user, platform = "youtube") {
  return (await db.query(`SELECT * FROM ${s}.social_accounts WHERE user_id = $1 AND platform = $2`, [user, platform])).rows[0];
}
async function intentRow(s, hash) {
  return (await db.query(`SELECT * FROM ${s}.social_connection_intents WHERE state_hash = $1`, [hash])).rows[0];
}

for (const s of schemas) {
  test(`${s}: legacy accounts are retained without fabricated proof or profile adoption`, async () => {
    const row = await accountRow(s, legacyUser);
    assert.equal(row.zernio_account_id, "legacy-account");
    assert.equal(row.publishing_verified_at, null);
    assert.equal(row.disconnect_pending, false);
    assert.equal(row.disconnect_reconcile_ready, false);
    assert.equal(row.disconnect_completed_at, null);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${s}.social_profile_bindings WHERE user_id=$1`, [legacyUser])).rows[0].n, 0);
  });

  test(`${s}: stable server profile identity is reused and creation can be claimed once`, async () => {
    const f = await newProfile(s);
    const again = (await asRole("service_role", () => db.query(
      `SELECT ${s}.social_get_or_create_profile_binding($1) AS value`, [f.user],
    ))).rows[0].value;
    assert.equal(again.id, f.row.id);
    assert.equal(again.external_id, "purama-ai:" + f.row.id);
    assert.equal(again.profile_name, "PURAMA " + f.row.id);
    const claim = () => asRole("service_role", () => db.query(
      `SELECT ${s}.social_claim_profile_creation($1) AS claimed`, [f.row.id],
    ));
    assert.equal((await claim()).rows[0].claimed, true);
    assert.equal((await claim()).rows[0].claimed, false);
    const profile = providerId();
    await asRole("service_role", () => db.query(`SELECT ${s}.social_finish_profile_binding($1,$2)`, [f.row.id, profile]));
    await asRole("service_role", () => db.query(`SELECT ${s}.social_finish_profile_binding($1,$2)`, [f.row.id, profile]));
    await assert.rejects(asRole("service_role", () => db.query(`SELECT ${s}.social_finish_profile_binding($1,$2)`, [f.row.id, providerId()])), /already_fixed/);
  });

  test(`${s}: another user cannot bind the same external profile`, async () => {
    const f = await readyProfile(s); const other = await newProfile(s);
    await assert.rejects(asRole("service_role", () => db.query(
      `SELECT ${s}.social_finish_profile_binding($1,$2)`, [other.row.id, f.profile],
    )), /unique constraint/);
  });

  test(`${s}: a new intent supersedes only the same user's platform and rejects unbound profiles`, async () => {
    const f = await readyProfile(s); const first = await begin(s, f);
    const otherPlatform = await begin(s, f, { platform: "instagram" });
    const current = await begin(s, f);
    assert.equal((await intentRow(s, first.hash)).status, "superseded");
    assert.notEqual((await intentRow(s, first.hash)).consumed_at, null);
    assert.equal((await intentRow(s, otherPlatform.hash)).status, "pending");
    assert.equal((await intentRow(s, current.hash)).status, "pending");
    await assert.rejects(begin(s, { ...f, profile: providerId() }), /not_ready/);
    await assert.rejects(finish(s, f, first), /state_closed/);
  });

  test(`${s}: verified binding and nonce consumption commit atomically and replay is inert`, async () => {
    const f = await readyProfile(s); const intent = await begin(s, f); const account = providerId();
    assert.deepEqual(await finish(s, f, intent, account), { status: "bound" });
    const first = await accountRow(s, f.user);
    assert.equal(first.zernio_account_id, account); assert.equal(first.zernio_profile_id, f.profile);
    assert.equal(first.account_name, "Verified provider name"); assert.equal(first.is_active, true);
    assert(first.publishing_verified_at instanceof Date);
    const nonce = await intentRow(s, intent.hash);
    assert.equal(nonce.status, "bound"); assert.equal(nonce.zernio_account_id, account);
    assert.equal(nonce.consumed_at.toISOString(), first.publishing_verified_at.toISOString());
    await db.query(`UPDATE ${s}.social_accounts SET is_active=false WHERE user_id=$1`, [f.user]);
    assert.deepEqual(await finish(s, f, intent, account), { status: "already_processed" });
    const replay = await accountRow(s, f.user);
    assert.equal(replay.is_active, false);
    assert.equal(replay.publishing_verified_at.toISOString(), first.publishing_verified_at.toISOString());
    await assert.rejects(finish(s, f, intent, providerId()), /replay_conflict/);
  });

  test(`${s}: mismatched contexts and expired intents cannot bind`, async () => {
    const f = await readyProfile(s); const intent = await begin(s, f);
    const other = await readyProfile(s);
    await assert.rejects(finish(s, other, intent), /binding_mismatch/);
    await assert.rejects(finish(s, f, { ...intent, platform: "tiktok" }), /binding_mismatch/);
    await db.query(`UPDATE ${s}.social_connection_intents SET issued_at=statement_timestamp()-interval '11 minutes',
      expires_at=statement_timestamp()-interval '1 minute' WHERE state_hash=$1`, [intent.hash]);
    await assert.rejects(finish(s, f, intent), /state_closed/);
    assert.equal(await accountRow(s, f.user), undefined);
  });

  test(`${s}: a rolled back finalization leaves no account/proof and preserves a retryable intent`, async () => {
    const f = await readyProfile(s); const intent = await begin(s, f); const account = providerId();
    await db.exec("BEGIN");
    assert.deepEqual(await finish(s, f, intent, account), { status: "bound" });
    await db.exec("ROLLBACK");
    assert.equal(await accountRow(s, f.user), undefined);
    assert.equal((await intentRow(s, intent.hash)).status, "pending");
    assert.deepEqual(await finish(s, f, intent, account), { status: "bound" });
  });

  test(`${s}: one provider account cannot become verified for two users`, async () => {
    const a = await readyProfile(s); const b = await readyProfile(s); const account = providerId();
    await finish(s, a, await begin(s, a), account);
    const intent = await begin(s, b);
    await assert.rejects(finish(s, b, intent, account), /account_already_bound/);
    assert.equal(await accountRow(s, b.user), undefined);
    assert.equal((await intentRow(s, intent.hash)).status, "pending");
  });

  test(`${s}: identity changes clear inherited proof while deactivation retains it for safe reconciliation`, async () => {
    const f = await readyProfile(s); await finish(s, f, await begin(s, f));
    const original = await accountRow(s, f.user);
    await asRole("service_role", () => db.query(`UPDATE ${s}.social_accounts SET is_active=false WHERE id=$1`, [original.id]));
    assert.equal((await accountRow(s, f.user)).publishing_verified_at.toISOString(), original.publishing_verified_at.toISOString());
    await assert.rejects(asRole("service_role", () => db.query(
      `UPDATE ${s}.social_accounts SET zernio_account_id=$2 WHERE id=$1`, [original.id, providerId()],
    )), /permission denied/);
    // Simulate a privileged identity migration; the guard must still erase proof.
    await db.query(`UPDATE ${s}.social_accounts SET zernio_account_id=$2 WHERE id=$1`, [original.id, providerId()]);
    assert.equal((await accountRow(s, f.user)).publishing_verified_at, null);
  });

  test(`${s}: pending disconnect blocks callbacks; DB completion time invalidates all older intents`, async () => {
    const f = await readyProfile(s); const account = providerId(); await finish(s, f, await begin(s, f), account);
    const beforeDisconnect = await begin(s, f);
    const old = await accountRow(s, f.user);
    await asRole("service_role", () => db.query(`UPDATE ${s}.social_accounts
      SET is_active=false, disconnect_pending=true, disconnect_reconcile_ready=false WHERE id=$1`, [old.id]));
    assert.equal((await accountRow(s, f.user)).disconnect_reconcile_ready, false);
    await assert.rejects(finish(s, f, beforeDisconnect, account), /disconnect_requires_new_connection/);
    assert.equal((await intentRow(s, beforeDisconnect.hash)).status, "pending");
    const duringDisconnect = await begin(s, f);
    await assert.rejects(finish(s, f, duringDisconnect, account), /disconnect_requires_new_connection/);
    // Only the original HTTP owner marks this after its final external action.
    // Readiness permits a GET reconciliation, never an OAuth bypass of pending.
    await asRole("service_role", () => db.query(`UPDATE ${s}.social_accounts
      SET disconnect_reconcile_ready=true WHERE id=$1 AND disconnect_pending=true`, [old.id]));
    assert.equal((await accountRow(s, f.user)).disconnect_reconcile_ready, true);
    await assert.rejects(finish(s, f, duringDisconnect, account), /disconnect_requires_new_connection/);
    await asRole("service_role", () => db.query(`UPDATE ${s}.social_accounts
      SET disconnect_pending=false, disconnect_reconcile_ready=false WHERE id=$1`, [old.id]));
    const finished = await accountRow(s, f.user);
    assert.equal(finished.is_active, false); assert.equal(finished.disconnect_pending, false);
    assert.equal(finished.disconnect_reconcile_ready, false);
    assert(finished.disconnect_completed_at >= (await intentRow(s, duringDisconnect.hash)).created_at);
    assert.equal(finished.publishing_verified_at.toISOString(), old.publishing_verified_at.toISOString());
    await assert.rejects(finish(s, f, duringDisconnect, account), /disconnect_requires_new_connection/);
    const fresh = await begin(s, f);
    assert.deepEqual(await finish(s, f, fresh, account), { status: "bound" });
    assert.equal((await accountRow(s, f.user)).is_active, true);
    assert.equal((await accountRow(s, f.user)).disconnect_reconcile_ready, false);
  });

  test(`${s}: readiness cannot precede ownership and service writes cannot forge identities, proof or completion time`, async () => {
    const f = await readyProfile(s); await finish(s, f, await begin(s, f));
    const current = await accountRow(s, f.user);
    await asRole("service_role", () => db.query(`UPDATE ${s}.social_accounts
      SET disconnect_reconcile_ready=true WHERE id=$1`, [current.id]));
    assert.equal((await accountRow(s, f.user)).disconnect_reconcile_ready, false);
    await asRole("service_role", () => db.query(`UPDATE ${s}.social_accounts
      SET is_active=false, disconnect_pending=true, disconnect_reconcile_ready=true WHERE id=$1`, [current.id]));
    assert.equal((await accountRow(s, f.user)).disconnect_reconcile_ready, false);
    await asRole("service_role", () => db.query(`UPDATE ${s}.social_accounts
      SET disconnect_reconcile_ready=true WHERE id=$1`, [current.id]));
    assert.equal((await accountRow(s, f.user)).disconnect_reconcile_ready, true);
    // The trigger clears readiness even if an older caller forgets that column.
    await asRole("service_role", () => db.query(`UPDATE ${s}.social_accounts SET disconnect_pending=false WHERE id=$1`, [current.id]));
    assert.equal((await accountRow(s, f.user)).disconnect_reconcile_ready, false);
    for (const column of ["publishing_verified_at", "disconnect_completed_at"]) {
      await assert.rejects(asRole("service_role", () => db.query(
        `UPDATE ${s}.social_accounts SET ${column}=clock_timestamp() WHERE id=$1`, [current.id],
      )), /permission denied/);
    }
    await assert.rejects(asRole("service_role", () => db.query(`DELETE FROM ${s}.social_accounts WHERE id=$1`, [current.id])), /permission denied/);
    await assert.rejects(asRole("service_role", () => db.query(`INSERT INTO ${s}.social_accounts DEFAULT VALUES`)), /permission denied/);
  });

  for (const role of ["anon", "authenticated"]) {
    test(`${s}: ${role} cannot forge profiles, intents, bindings or call privileged RPCs`, async () => {
      const f = await readyProfile(s);
      for (const table of ["social_profile_bindings", "social_connection_intents"]) {
        await assert.rejects(asRole(role, () => db.query(`SELECT * FROM ${s}.${table}`)), /permission denied/);
        await assert.rejects(asRole(role, () => db.query(`DELETE FROM ${s}.${table}`)), /permission denied/);
      }
      await assert.rejects(asRole(role, () => db.query(`SELECT ${s}.social_get_or_create_profile_binding($1)`, [f.user])), /permission denied/);
      await assert.rejects(asRole(role, () => db.query(`SELECT ${s}.social_claim_profile_creation($1)`, [f.row.id])), /permission denied/);
      await assert.rejects(asRole(role, () => db.query(`UPDATE ${s}.social_accounts SET zernio_account_id='forged' WHERE user_id=$1`, [legacyUser])), /permission denied/);
      await assert.rejects(asRole(role, () => db.query(`UPDATE ${s}.social_accounts SET publishing_verified_at=clock_timestamp()`)), /permission denied/);
      await assert.rejects(asRole(role, () => db.query(`UPDATE ${s}.social_accounts SET disconnect_reconcile_ready=true`)), /permission denied/);
    });
  }

  test(`${s}: service writes cannot bypass identity/nonce RPCs with direct INSERT, DELETE or identity UPDATE`, async () => {
    const f = await readyProfile(s); const intent = await begin(s, f);
    for (const table of ["social_profile_bindings", "social_connection_intents"]) {
      await assert.rejects(asRole("service_role", () => db.query(`DELETE FROM ${s}.${table}`)), /permission denied/);
      await assert.rejects(asRole("service_role", () => db.query(`INSERT INTO ${s}.${table} DEFAULT VALUES`)), /permission denied/);
    }
    await assert.rejects(asRole("service_role", () => db.query(
      `UPDATE ${s}.social_profile_bindings SET zernio_profile_id=$2 WHERE id=$1`, [f.row.id, providerId()],
    )), /permission denied/);
    await assert.rejects(asRole("service_role", () => db.query(
      `UPDATE ${s}.social_connection_intents SET nonce=$2 WHERE state_hash=$1`, [intent.hash, randomUUID()],
    )), /permission denied/);
    const cancelled = await asRole("service_role", () => db.query(
      `UPDATE ${s}.social_connection_intents SET status='cancelled', consumed_at=clock_timestamp()
        WHERE state_hash=$1 AND status='pending' RETURNING state_hash`, [intent.hash],
    ));
    assert.equal(cancelled.rows[0].state_hash, intent.hash);
    const pending = await newProfile(s);
    await asRole("service_role", () => db.query(
      `UPDATE ${s}.social_profile_bindings SET creation_status='uncertain', updated_at=clock_timestamp() WHERE id=$1`, [pending.row.id],
    ));
  });
}

test("reapplying the migrations preserves established proof and connection intents", async () => {
  const f = await readyProfile("public"); const intent = await begin("public", f); const account = providerId();
  await finish("public", f, intent, account);
  const before = await accountRow("public", f.user);
  const disconnect = await readyProfile("purama_ai"); await finish("purama_ai", disconnect, await begin("purama_ai", disconnect));
  await asRole("service_role", () => db.query(`UPDATE purama_ai.social_accounts
    SET is_active=false, disconnect_pending=true WHERE user_id=$1`, [disconnect.user]));
  await asRole("service_role", () => db.query(`UPDATE purama_ai.social_accounts
    SET disconnect_reconcile_ready=true WHERE user_id=$1`, [disconnect.user]));
  await db.exec(publication); await db.exec(binding);
  const after = await accountRow("public", f.user);
  assert.equal(after.publishing_verified_at.toISOString(), before.publishing_verified_at.toISOString());
  assert.equal((await intentRow("public", intent.hash)).status, "bound");
  const pending = await accountRow("purama_ai", disconnect.user);
  assert.equal(pending.disconnect_pending, true); assert.equal(pending.disconnect_reconcile_ready, true);
});
