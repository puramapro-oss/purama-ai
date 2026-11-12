import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const ACTORS = Object.freeze({
  owner: '00000000-0000-4000-8000-000000000001',
  b: '00000000-0000-4000-8000-000000000002',
  c: '00000000-0000-4000-8000-000000000003',
  d: '00000000-0000-4000-8000-000000000004',
  e: '00000000-0000-4000-8000-000000000005',
  outsider: '00000000-0000-4000-8000-000000000006',
});
export const RPC_SIGNATURE = 'purama_ai.entraide_mission_mutate(uuid,text,uuid,jsonb,bigint)';
const MIGRATIONS = [
  '20260904000000_entraide.sql',
  '20260905000000_entraide_profile_privacy.sql',
  '20261110000000_entraide_missions_atomic.sql',
  '20261110001000_entraide_own_profile.sql',
];
const ROLES = ['anon', 'authenticated', 'service_role'];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function createFixture() {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must point to a disposable PostgreSQL test service');
  const source = new URL(process.env.DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(source.hostname), 'Only a local/CI PostgreSQL service is accepted');
  const database = `entraide_test_${randomUUID().replaceAll('-', '')}`;
  const control = new pg.Client({ connectionString: source.toString(), connectionTimeoutMillis: 5_000 });
  const clients = new Set();
  const rolesCreated = [];
  let created = false;
  let closed = false;
  let closing = false;
  let admin;
  let profileAccessBefore;

  async function profileAccess() {
    const policies = (await admin.query(`
      SELECT policyname,roles,cmd,qual,with_check FROM pg_policies
      WHERE schemaname='purama_ai' AND tablename='entraide_profils'
      ORDER BY policyname
    `)).rows;
    const coordinates = (await admin.query(`
      SELECT r.role_name,c.column_name,
        has_column_privilege(r.role_name,'purama_ai.entraide_profils',c.column_name,'SELECT') AS allowed
      FROM unnest(ARRAY['anon','authenticated']) AS r(role_name)
      CROSS JOIN unnest(ARRAY['location_lat','location_lng']) AS c(column_name)
      ORDER BY r.role_name,c.column_name
    `)).rows;
    return { policies, coordinates };
  }

  async function close() {
    if (closed) return;
    closing = true;
    await Promise.allSettled([...clients].map((client) => client.end()));
    if (created) await control.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    for (const role of rolesCreated.reverse()) await control.query(`DROP ROLE ${role}`);
    await control.end();
    closed = true;
  }

  try {
    await control.connect();
    for (const role of ROLES) {
      const exists = (await control.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount > 0;
      if (!exists) {
        await control.query(`CREATE ROLE ${role} NOLOGIN${role === 'service_role' ? ' BYPASSRLS' : ''}`);
        rolesCreated.push(role);
      }
    }
    await control.query(`CREATE DATABASE "${database}"`);
    created = true;
    const connection = new URL(source);
    connection.pathname = `/${database}`;

    async function connect(role = null, actorId = null) {
      assert.ok(role === null || ROLES.includes(role));
      const client = new pg.Client({
        connectionString: connection.toString(),
        connectionTimeoutMillis: 5_000,
        application_name: 'entraide-postgres-tests',
        options: '-c statement_timeout=12000 -c idle_in_transaction_session_timeout=15000',
      });
      client.on('error', (error) => {
        if (!closing) console.error(`PostgreSQL test connection error: ${error.code ?? error.name}`);
      });
      await client.connect();
      clients.add(client);
      if (role !== null) await client.query(`SET ROLE ${role}`);
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [actorId ?? '']);
      return client;
    }

    async function release(client) {
      clients.delete(client);
      await client.end();
    }

    async function beginActor(actorId) {
      const client = await connect();
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actorId ?? '']);
      return client;
    }

    async function asActor(actorId, work) {
      const client = await beginActor(actorId);
      try {
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        await release(client);
      }
    }

    async function asRole(role, actorId, work) {
      const client = await connect(role, actorId);
      try { return await work(client); }
      finally { await release(client); }
    }

    admin = await connect();
    await admin.query(`
      CREATE SCHEMA auth;
      CREATE SCHEMA purama_ai;
      CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE SET search_path = ''
        AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      GRANT USAGE ON SCHEMA auth,purama_ai,public TO anon,authenticated,service_role;
      GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated,service_role;
    `);
    for (const name of MIGRATIONS) {
      const migrationPath = fileURLToPath(new URL(`../../supabase/migrations/${name}`, import.meta.url));
      if (name === '20261110001000_entraide_own_profile.sql') profileAccessBefore = await profileAccess();
      await admin.query(await fs.readFile(migrationPath, 'utf8'));
    }

    async function reset() {
      await admin.query('TRUNCATE auth.users CASCADE');
      for (const id of Object.values(ACTORS)) {
        await admin.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [id, `${id}@example.invalid`]);
      }
    }

    return { admin, connect, release, beginActor, asActor, asRole, reset, close, database, profileAccess, profileAccessBefore };
  } catch (error) {
    try { await close(); } catch { /* Keep the setup error as the primary failure. */ }
    throw error;
  }
}

export async function rpc(client, { requestId = randomUUID(), action, missionId = null, payload = {}, expectedVersion = null }) {
  const result = await client.query(
    'SELECT purama_ai.entraide_mission_mutate($1::uuid,$2::text,$3::uuid,$4::jsonb,$5::bigint) AS response',
    [requestId, action, missionId, JSON.stringify(payload), expectedVersion],
  );
  return result.rows[0].response;
}

export async function waitForLockWaiters(admin, clients) {
  const pids = clients.map((client) => client.processID);
  assert.equal(new Set(pids).size, pids.length, 'Each concurrent actor must use a distinct PostgreSQL backend');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = (await admin.query(
      "SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE pid=ANY($1::int[])", [pids],
    )).rows;
    if (rows.length === pids.length && rows.every((row) => row.wait_event_type === 'Lock')) return rows;
    await delay(20);
  }
  throw new Error(`Expected real PostgreSQL lock waiters for backend PIDs ${pids.join(',')}`);
}

export function transactionResult(client, command) {
  return rpc(client, command).then(async (response) => {
    await client.query('COMMIT');
    return { ok: true, response };
  }, async (error) => {
    await client.query('ROLLBACK');
    return { ok: false, error };
  });
}
