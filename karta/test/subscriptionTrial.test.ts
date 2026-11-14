import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const fixture = readFileSync(new URL('./fixtures/subscriptions.sql', import.meta.url), 'utf8');
const historical = readFileSync(new URL('../../supabase/migrations/20260727000000_subscriptions_security_and_trial.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../../supabase/migrations/20261110043500_trial_admission_atomic.sql', import.meta.url), 'utf8');
const user = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(fixture + historical + migration);
  await db.query('INSERT INTO auth.users (id) VALUES ($1), ($2)', [user, other]);
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('RESET ROLE; TRUNCATE purama_ai.subscriptions;');
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [user]);
});

async function seed(plan: string | null, status: string | null, used = false) {
  await db.query('INSERT INTO purama_ai.subscriptions (user_id, plan_type, status, has_used_trial) VALUES ($1, $2, $3, $4)',
    [user, plan, status, used]);
}

async function trial(plan: string | null = 'pro') {
  await db.exec('SET ROLE authenticated');
  return db.query<{ plan_type: string; status: string; has_used_trial: boolean; valid_duration: boolean }>(
    `SELECT plan_type, status, has_used_trial,
       trial_ends_at BETWEEN now() + interval '14 days' - interval '5 seconds' AND now() + interval '14 days' AS valid_duration
     FROM purama_ai.start_trial($1)`, [plan]);
}

async function snapshot() {
  await db.exec('RESET ROLE');
  return (await db.query<Record<string, unknown>>('SELECT * FROM purama_ai.subscriptions ORDER BY user_id')).rows;
}

describe('subscription trial admission on the real SQL function', () => {
  it.each(['starter', 'pro', 'ultime'])('creates one %s trial when no row exists', async plan => {
    expect((await trial(plan)).rows).toEqual([{ plan_type: plan, status: 'trialing', has_used_trial: true, valid_duration: true }]);
    expect(await snapshot()).toHaveLength(1);
  });

  it('admits the default free/active account without replacing its identity or Stripe customer', async () => {
    await seed('free', 'active');
    await db.query("UPDATE purama_ai.subscriptions SET stripe_customer_id = 'cus_fixture'");
    const before = (await snapshot())[0];
    await trial();
    expect((await snapshot())[0]).toMatchObject({ id: before.id, created_at: before.created_at, stripe_customer_id: 'cus_fixture', status: 'trialing' });
  });

  it.each([
    ['pro', 'active', false, 'Déjà abonné'],
    ['pro', 'trialing', false, 'Essai déjà'],
    ['free', 'active', true, 'Essai déjà'],
    ['pro', 'canceled', true, 'Essai déjà'],
    [null, 'active', false, 'incompatible'],
    ['free', null, false, 'incompatible'],
  ] as const)('preserves the ineligible state %s/%s/used=%s', async (plan, status, used, message) => {
    await seed(plan, status, used);
    const before = await snapshot();
    await expect(trial()).rejects.toThrow(message);
    expect(await snapshot()).toEqual(before);
  });

  it('retains eligibility for an unused canceled subscription', async () => {
    await seed('pro', 'canceled');
    expect((await trial()).rows[0].status).toBe('trialing');
  });

  it.each([null, '', 'free', 'administrator'])('rejects invalid plan %s without consuming the trial', async plan => {
    await expect(trial(plan)).rejects.toThrow('Plan invalide');
    expect(await snapshot()).toEqual([]);
  });

  it('rejects an authenticated role without an authenticated user', async () => {
    await db.query("SELECT set_config('request.jwt.claim.sub', '', false)");
    await expect(trial()).rejects.toThrow('Non authentifié');
    expect(await snapshot()).toEqual([]);
  });

  it('does not extend or change a successful trial on replay', async () => {
    await trial('starter');
    const before = await snapshot();
    await expect(trial('ultime')).rejects.toThrow('Essai déjà');
    expect(await snapshot()).toEqual(before);
  });

  it('keeps authenticated reads scoped to their user', async () => {
    await seed('free', 'active');
    await db.query('INSERT INTO purama_ai.subscriptions (user_id) VALUES ($1)', [other]);
    await db.exec('SET ROLE authenticated');
    expect((await db.query('SELECT user_id FROM purama_ai.subscriptions')).rows).toEqual([{ user_id: user }]);
  });

  it.each(['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])('revokes inherited client %s privileges', async privilege => {
    const result = await db.query<{ role: string; allowed: boolean }>(
      `SELECT role, has_table_privilege(role, 'purama_ai.subscriptions', $1) AS allowed
       FROM (VALUES ('anon'), ('authenticated')) AS roles(role)`, [privilege]);
    expect(result.rows.every(row => row.allowed === false)).toBe(true);
  });

  it('refuses a real client update, deletion, truncation and direct plan insert', async () => {
    await seed('free', 'active');
    const before = await snapshot();
    await db.exec('SET ROLE authenticated');
    for (const sql of [
      'UPDATE purama_ai.subscriptions SET has_used_trial = false',
      'DELETE FROM purama_ai.subscriptions',
      'TRUNCATE purama_ai.subscriptions',
      `INSERT INTO purama_ai.subscriptions (user_id, plan_type) VALUES ('${other}', 'ultime')`,
    ]) await expect(db.exec(sql)).rejects.toThrow('permission denied');
    expect(await snapshot()).toEqual(before);
  });

  it('rejects anonymous execution even with a forged user setting', async () => {
    await db.exec('SET ROLE anon');
    await expect(db.query("SELECT purama_ai.start_trial('pro')")).rejects.toThrow('permission denied');
    const grants = await db.query<{ allowed: boolean }>("SELECT has_function_privilege('anon', 'purama_ai.start_trial(text)', 'EXECUTE') AS allowed");
    expect(grants.rows[0].allowed).toBe(false);
  });

  it('retains service-role writes and the trial flag when a webhook updates the plan', async () => {
    await trial();
    await db.exec('SET ROLE service_role');
    await db.query("UPDATE purama_ai.subscriptions SET plan_type='ultime', status='active' WHERE user_id=$1", [user]);
    expect((await snapshot())[0]).toMatchObject({ plan_type: 'ultime', status: 'active', has_used_trial: true });
  });

  it('uses a fixed trusted search path and safely reapplies the migration', async () => {
    await db.exec(migration);
    const result = await db.query<{ proconfig: string[] }>("SELECT proconfig FROM pg_proc WHERE oid='purama_ai.start_trial(text)'::regprocedure");
    expect(result.rows[0].proconfig).toContain('search_path=pg_catalog, pg_temp');
    await db.exec('CREATE TEMP TABLE subscriptions (user_id UUID);');
    expect((await trial()).rows[0].status).toBe('trialing');
  });
});
