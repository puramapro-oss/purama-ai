import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const migrationsDirectory = new URL('../../supabase/migrations/', import.meta.url);
const allowedRoles = new Set(['anon', 'authenticated', 'service_role']);
const createRolesSql = `
  DO $$ BEGIN CREATE ROLE anon NOLOGIN;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated NOLOGIN;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`;

export const USERS = Object.freeze(Object.fromEntries(
  [...'abcdefghijklmnopqrst'].map((name, index) => [
    name,
    `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  ]),
));

async function createNativeTestDb(rawUrl) {
  let adminUrl;
  try {
    adminUrl = new URL(rawUrl);
  } catch {
    throw new Error('ENTRAIDE_DATABASE_URL must be a valid isolated local test URL');
  }
  // Native tests must use an explicitly isolated local cluster. Never point this
  // harness at an application database, remote server or the default PG port.
  if (!['postgres:', 'postgresql:'].includes(adminUrl.protocol)
      || !['localhost', '127.0.0.1'].includes(adminUrl.hostname)
      || !adminUrl.port || adminUrl.port === '5432'
      || adminUrl.pathname !== '/entraide_test_admin'
      || adminUrl.search || adminUrl.hash) {
    throw new Error('ENTRAIDE_DATABASE_URL must name entraide_test_admin on localhost/127.0.0.1 with an explicit non-default port and no query/hash');
  }
  const pg = await import(process.env.ENTRAIDE_PG_MODULE || 'pg');
  const Client = pg.Client || pg.default?.Client;
  if (!Client) throw new Error('The PostgreSQL test module must export Client');
  const config = (url) => ({
    connectionString: url.toString(),
    connectionTimeoutMillis: 10_000,
    application_name: 'entraide-local-test',
  });
  const name = `entraide_test_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client(config(adminUrl));
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${name}`;
  let created = false;
  let connected = false;
  let client;
  try {
    await admin.connect();
    connected = true;
    // Roles are cluster-wide. Serialize their creation in the shared admin DB,
    // verify existing definitions, and never alter pre-existing privileges.
    await admin.query('SELECT pg_advisory_lock(780200, 0)');
    try {
      await admin.query(createRolesSql);
      const { rows } = await admin.query(`
        SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
        FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')
      `);
      if (rows.length !== 3 || rows.some((role) => role.rolcanlogin || role.rolsuper
          || role.rolbypassrls !== (role.rolname === 'service_role'))) {
        throw new Error('Unexpected role privileges in the local test cluster');
      }
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      created = true;
    } finally {
      await admin.query('SELECT pg_advisory_unlock(780200, 0)');
    }
    client = new Client(config(testUrl));
    await client.connect();
  } catch (error) {
    const failures = [error];
    if (client) {
      try { await client.end(); } catch (cleanupError) { failures.push(cleanupError); }
    }
    if (created) {
      try { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); }
      catch (cleanupError) { failures.push(cleanupError); }
    }
    if (connected) {
      try { await admin.end(); } catch (cleanupError) { failures.push(cleanupError); }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Native test setup and cleanup failed');
    throw error;
  }

  const transactions = new Set();
  let closed = false;
  return {
    engine: 'postgres',
    query: (sql, params) => client.query(sql, params),
    exec: (sql) => client.query(sql),
    async transaction(body) {
      if (closed) throw new Error('Test database is closed');
      // Every transaction gets its own physical connection. Promise.all of RPCs
      // therefore exercises actual PostgreSQL lock contention in native mode.
      const connection = new Client(config(testUrl));
      transactions.add(connection);
      let began = false;
      try {
        await connection.connect();
        await connection.query('BEGIN');
        began = true;
        const result = await body({
          query: (sql, params) => connection.query(sql, params),
          exec: (sql) => connection.query(sql),
        });
        await connection.query('COMMIT');
        began = false;
        return result;
      } catch (error) {
        if (began) {
          try { await connection.query('ROLLBACK'); }
          catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Test transaction and rollback failed'); }
        }
        throw error;
      } finally {
        transactions.delete(connection);
        await connection.end();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        const results = await Promise.allSettled([
          client.end(), ...[...transactions].map((connection) => connection.end()),
        ]);
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure) throw failure.reason;
      } finally {
        await admin.end();
      }
    },
  };
}

export async function createDb({ extraMigrations = [], beforeCurrentMigrations, alreadyApplied = [] } = {}) {
  let db;
  if (process.env.ENTRAIDE_DATABASE_URL) {
    db = await createNativeTestDb(process.env.ENTRAIDE_DATABASE_URL);
  } else {
    // Lazy import: native PostgreSQL runs never load or allocate PGlite/WASM.
    // Callers may reuse an installed dependency without changing the app graph.
    const { PGlite } = await import(process.env.ENTRAIDE_PGLITE_MODULE || '@electric-sql/pglite');
    db = new PGlite();
    db.engine = 'pglite';
  }
  try {
    if (db.engine === 'pglite') await db.exec(createRolesSql);
    await db.exec(`
      CREATE SCHEMA auth;
      CREATE SCHEMA purama_ai;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      SET search_path = '' AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      GRANT USAGE ON SCHEMA auth, purama_ai TO anon, authenticated, service_role;
      -- Models the managed auth schema's service-only identity lookup. Application
      -- table privileges below come exclusively from the actual migrations.
      GRANT SELECT ON auth.users TO service_role;
    `);
    const names = await readdir(migrationsDirectory);
    const baseline = [
      '20260904000000_entraide.sql',
      '20260905000000_entraide_profile_privacy.sql',
    ];
    const current = names.filter((name) => /^2026111002\d{4}_entraide.*\.sql$/.test(name)).sort();
    if (alreadyApplied.some(name => !current.includes(name))) throw new Error('Unknown already-applied migration');
    const selected = [...new Set([...baseline, ...current, ...extraMigrations])];
    for (const name of selected) {
      if (!/^[A-Za-z0-9_-]+\.sql$/.test(name)) throw new Error('Invalid migration filename');
      // Models the migration runner skipping versions recorded before upgrade.
      // The fixture callback must actually create that historical SQL state.
      if (alreadyApplied.includes(name)) continue;
      await db.exec(await readFile(new URL(name, migrationsDirectory), 'utf8'));
      if (name === baseline.at(-1) && beforeCurrentMigrations) {
        await beforeCurrentMigrations(db);
      }
    }
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

export async function seedUsers(db, ids) {
  for (const id of ids) {
    await db.query('INSERT INTO auth.users (id) VALUES ($1::uuid) ON CONFLICT DO NOTHING', [id]);
  }
}

export async function asRole(db, role, actorId, sql, params = []) {
  if (!allowedRoles.has(role)) throw new Error('Unsupported test role');
  return db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    await tx.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [actorId ?? '']);
    return tx.query(sql, params);
  });
}

export async function callRpc(db, name, actorId, action, payload = {}) {
  if (!/^entraide_[a-z_]+_command$/.test(name)) throw new Error('Unsupported RPC name');
  const result = await asRole(
    db,
    'service_role',
    actorId,
    `SELECT purama_ai.${name}($1::uuid, $2::text, $3::jsonb) AS result`,
    [actorId, action, JSON.stringify(payload)],
  );
  return result.rows[0].result;
}
