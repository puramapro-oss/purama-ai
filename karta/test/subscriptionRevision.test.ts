import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const sql = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
const fixture = sql('./fixtures/subscriptions.sql');
const historical = sql('../../supabase/migrations/20260727000000_subscriptions_security_and_trial.sql');
const atomicTrial = sql('../../supabase/migrations/20261110043500_trial_admission_atomic.sql');
const journal = sql('../../supabase/migrations/20261110100000_stripe_reconciliation_events.sql');
const migration = sql('../../supabase/migrations/20261111100000_subscription_projection_revision.sql');
const user = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
let db: PGlite;
let legacyBefore: Record<string, unknown>;
let legacyAfter: Record<string, unknown>;
let tablesBefore: unknown[];
let tablesAfter: unknown[];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(fixture + historical + atomicTrial + journal);
  await db.query('INSERT INTO auth.users (id) VALUES ($1), ($2)', [user, other]);
  await db.query(`INSERT INTO purama_ai.subscriptions
    (user_id, stripe_customer_id, plan_type, status, has_used_trial, trial_ends_at)
    VALUES ($1, 'cus_legacy', 'pro', 'active', true, '2026-01-01T00:00:00Z')`, [user]);
  legacyBefore = (await db.query<Record<string, unknown>>('SELECT * FROM purama_ai.subscriptions')).rows[0];
  tablesBefore = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='purama_ai' ORDER BY tablename")).rows;
  await db.exec(migration);
  legacyAfter = (await db.query<Record<string, unknown>>('SELECT * FROM purama_ai.subscriptions')).rows[0];
  tablesAfter = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='purama_ai' ORDER BY tablename")).rows;
}, 20_000);

afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('RESET ROLE; TRUNCATE purama_ai.subscriptions;');
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [user]);
});

async function asRole<T>(role: 'anon' | 'authenticated' | 'service_role', work: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try { return await work(); } finally { await db.exec('RESET ROLE'); }
}

async function seed(options: { user?: string; customer?: string | null; subscription?: string | null; status?: string; used?: boolean; revision?: string } = {}) {
  await db.query(`INSERT INTO purama_ai.subscriptions
    (user_id, stripe_customer_id, stripe_subscription_id, plan_type, status, has_used_trial, revision)
    VALUES ($1, $2, $3, 'pro', $4, $5, $6::bigint)`,
  [options.user ?? user, options.customer === undefined ? 'cus_one' : options.customer,
    options.subscription === undefined ? 'sub_old' : options.subscription,
    options.status ?? 'active', options.used ?? true, options.revision ?? '0']);
  return (await db.query<{ id: string; revision: string }>(
    'SELECT id, revision::text FROM purama_ai.subscriptions WHERE user_id=$1', [options.user ?? user])).rows[0];
}

async function snapshot() {
  return (await db.query<Record<string, unknown>>(
    'SELECT *, revision::text AS revision FROM purama_ai.subscriptions ORDER BY user_id')).rows;
}

describe('subscription projection identity and database revision on composed SQL migrations', () => {
  it('preserves every historical value without inventing a Stripe identity or adding a ledger', () => {
    const { stripe_subscription_id, revision, ...unchanged } = legacyAfter;
    expect(stripe_subscription_id).toBeNull();
    expect(String(revision)).toBe('0');
    expect(unchanged).toEqual(legacyBefore);
    expect(tablesAfter).toEqual(tablesBefore);
  });

  it('persists a new Stripe identity even when the paid plan and status are unchanged, invalidating stale cancellation', async () => {
    const old = await seed();
    const applied = await asRole('service_role', () => db.query(`UPDATE purama_ai.subscriptions
      SET stripe_subscription_id='sub_new'
      WHERE id=$1 AND user_id=$2 AND stripe_customer_id='cus_one'
        AND stripe_subscription_id='sub_old' AND revision=$3::bigint
      RETURNING stripe_subscription_id, plan_type, status, revision::text`, [old.id, user, old.revision]));
    expect(applied.rows).toEqual([{ stripe_subscription_id: 'sub_new', plan_type: 'pro', status: 'active', revision: '1' }]);
    const stale = await asRole('service_role', () => db.query(`UPDATE purama_ai.subscriptions
      SET plan_type='free', status='canceled'
      WHERE id=$1 AND revision=$2::bigint AND stripe_subscription_id='sub_old' RETURNING id`, [old.id, old.revision]));
    expect(stale.rows).toEqual([]);
    expect((await snapshot())[0]).toMatchObject({ stripe_subscription_id: 'sub_new', plan_type: 'pro', status: 'active', revision: '1' });
  });

  it('confirms a replay by advancing revision without rewriting commercial fields, fencing an older same-id observation', async () => {
    const old = await seed();
    const before = (await snapshot())[0];
    const confirmation = await asRole('service_role', () => db.query(`UPDATE purama_ai.subscriptions
      SET updated_at=updated_at WHERE id=$1 AND revision=$2::bigint AND stripe_subscription_id='sub_old'
      RETURNING revision::text`, [old.id, old.revision]));
    expect(confirmation.rows).toEqual([{ revision: '1' }]);
    const { revision: _oldRevision, ...oldBusiness } = before;
    const { revision: newRevision, ...newBusiness } = (await snapshot())[0];
    expect(newRevision).toBe('1');
    expect(newBusiness).toEqual(oldBusiness);
    expect((await db.query(`UPDATE purama_ai.subscriptions SET status='past_due'
      WHERE id=$1 AND revision=$2::bigint RETURNING id`, [old.id, old.revision])).rows).toEqual([]);
    expect((await snapshot())[0].status).toBe('active');
  });

  it('prevents an older paid checkout snapshot from undoing a committed cancellation', async () => {
    const old = await seed();
    await db.query("UPDATE purama_ai.subscriptions SET plan_type='free', status='canceled' WHERE id=$1", [old.id]);
    const stale = await db.query(`UPDATE purama_ai.subscriptions SET plan_type='pro', status='active'
      WHERE id=$1 AND revision=$2::bigint RETURNING id`, [old.id, old.revision]);
    expect(stale.rows).toEqual([]);
    expect((await snapshot())[0]).toMatchObject({ plan_type: 'free', status: 'canceled', stripe_subscription_id: 'sub_old', revision: '1' });
  });

  it('advances on no-op and administrative updates instead of accepting a caller revision', async () => {
    await seed();
    await db.exec('UPDATE purama_ai.subscriptions SET status=status, revision=0');
    expect((await snapshot())[0].revision).toBe('1');
    await asRole('service_role', () => db.exec('UPDATE purama_ai.subscriptions SET revision=9007199254740991'));
    expect((await snapshot())[0].revision).toBe('2');
  });

  it('keeps distinct revisions when both timestamp-trigger updates share one transaction timestamp', async () => {
    await seed();
    await db.exec(`CREATE FUNCTION purama_ai.test_revision_timestamp() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at=now(); RETURN NEW; END; $$;
      CREATE TRIGGER update_subscriptions_updated_at BEFORE UPDATE ON purama_ai.subscriptions
      FOR EACH ROW EXECUTE FUNCTION purama_ai.test_revision_timestamp();`);
    let committed = false;
    try {
      await db.exec('BEGIN');
      const first = (await db.query<{ revision: string; updated_at: string }>('UPDATE purama_ai.subscriptions SET updated_at=updated_at RETURNING revision::text, updated_at::text')).rows[0];
      const second = (await db.query<{ revision: string; updated_at: string }>('UPDATE purama_ai.subscriptions SET updated_at=updated_at RETURNING revision::text, updated_at::text')).rows[0];
      expect(first.revision).toBe('1');
      expect(second.revision).toBe('2');
      expect(second.updated_at).toBe(first.updated_at);
      await db.exec('COMMIT'); committed = true;
    } finally {
      if (!committed) await db.exec('ROLLBACK');
      await db.exec('DROP TRIGGER update_subscriptions_updated_at ON purama_ai.subscriptions; DROP FUNCTION purama_ai.test_revision_timestamp();');
    }
  });

  it.each(['canceled', 'past_due'])('detaches a previous Stripe subscription when a new local trial is admitted from %s', async status => {
    const old = await seed({ status, used: false });
    const admitted = await asRole('authenticated', () => db.query<Record<string, unknown>>(
      "SELECT *, revision::text AS revision FROM purama_ai.start_trial('starter')"));
    expect(admitted.rows[0].stripe_subscription_id).toBeNull();
    expect(admitted.rows[0]).toMatchObject({ id: old.id, stripe_customer_id: 'cus_one', stripe_subscription_id: null,
      plan_type: 'starter', status: 'trialing', has_used_trial: true, revision: '1' });
    const once = await snapshot();
    await expect(asRole('authenticated', () => db.query("SELECT * FROM purama_ai.start_trial('pro')"))).rejects.toThrow('Essai déjà');
    expect(await snapshot()).toEqual(once);
  });

  it('starts a first local trial unbound at revision zero and preserves its one-time admission', async () => {
    const admitted = await asRole('authenticated', () => db.query<Record<string, unknown>>(
      "SELECT *, revision::text AS revision FROM purama_ai.start_trial('pro')"));
    expect(admitted.rows[0]).toMatchObject({ stripe_customer_id: null, stripe_subscription_id: null,
      status: 'trialing', has_used_trial: true, revision: '0' });
    const before = await snapshot();
    await expect(asRole('authenticated', () => db.query("SELECT * FROM purama_ai.start_trial('ultime')"))).rejects.toThrow('Essai déjà');
    expect(await snapshot()).toEqual(before);
  });

  it('retains client read isolation without granting writes to either new column', async () => {
    await seed();
    await seed({ user: other, customer: 'cus_other', subscription: 'sub_other' });
    const grants = await db.query<{ allowed: boolean }>(`SELECT has_column_privilege(role, 'purama_ai.subscriptions', col, privilege) AS allowed
      FROM (VALUES ('anon'), ('authenticated')) AS roles(role)
      CROSS JOIN (VALUES ('revision'), ('stripe_subscription_id')) AS columns(col)
      CROSS JOIN (VALUES ('INSERT'), ('UPDATE')) AS privileges(privilege)`);
    expect(grants.rows.every(row => row.allowed === false)).toBe(true);
    expect((await asRole('authenticated', () => db.query('SELECT user_id FROM purama_ai.subscriptions'))).rows).toEqual([{ user_id: user }]);
    for (const role of ['anon', 'authenticated'] as const) {
      await expect(asRole(role, () => db.query("UPDATE purama_ai.subscriptions SET stripe_subscription_id='sub_forged', revision=0"))).rejects.toThrow('permission denied');
    }
    const functionGrants = await db.query<{ allowed: boolean }>(`SELECT has_function_privilege(role,
      'purama_ai.advance_subscription_revision()', 'EXECUTE') AS allowed
      FROM (VALUES ('anon'), ('authenticated')) AS roles(role)`);
    expect(functionGrants.rows.every(row => row.allowed === false)).toBe(true);
  });

  it('retains service writes with a non-definer revision trigger and fixed search path', async () => {
    await seed();
    await asRole('service_role', () => db.exec("UPDATE purama_ai.subscriptions SET plan_type='ultime'"));
    expect((await snapshot())[0]).toMatchObject({ plan_type: 'ultime', has_used_trial: true, revision: '1' });
    const fn = (await db.query<{ prosecdef: boolean; proconfig: string[] }>(`SELECT prosecdef, proconfig FROM pg_proc
      WHERE oid='purama_ai.advance_subscription_revision()'::regprocedure`)).rows[0];
    expect(fn.prosecdef).toBe(false);
    expect(fn.proconfig).toContain('search_path=pg_catalog, pg_temp');
  });

  it.each(['sub_', 'other_123', 'sub_bad-hyphen', `sub_${'a'.repeat(252)}`])('refuses invalid provider identity %s without mutation', async subscription => {
    const old = await seed(); const before = await snapshot();
    await expect(db.query('UPDATE purama_ai.subscriptions SET stripe_subscription_id=$1 WHERE id=$2', [subscription, old.id])).rejects.toThrow('check constraint');
    expect(await snapshot()).toEqual(before);
  });

  it.each([null, '', '   '])('refuses a bound Stripe subscription without a usable customer %s', async customer => {
    await expect(seed({ customer })).rejects.toThrow('check constraint');
    expect(await snapshot()).toEqual([]);
  });

  it('accepts the maximum-length identity and permits unrelated unbound rows', async () => {
    await seed({ subscription: `sub_${'a'.repeat(251)}` });
    await seed({ user: other, customer: null, subscription: null });
    expect(await snapshot()).toHaveLength(2);
  });

  it('enforces unique subscription and customer bindings without rewriting the earlier owner', async () => {
    await seed(); const before = await snapshot();
    await expect(seed({ user: other, customer: 'cus_other' })).rejects.toThrow('unique constraint');
    expect(await snapshot()).toEqual(before);
    await expect(seed({ user: other, customer: 'cus_one', subscription: 'sub_other' })).rejects.toThrow('unique constraint');
    expect(await snapshot()).toEqual(before);
  });

  it.each(['-1', '9007199254740992'])('rejects an inserted revision outside the exact JSON range %s', async revision => {
    await expect(seed({ revision })).rejects.toThrow('check constraint');
    expect(await snapshot()).toEqual([]);
  });

  it('exhausts the last safe revision without wrapping, losing precision or changing rights', async () => {
    await seed({ revision: '9007199254740991' });
    const before = await snapshot();
    const value = (await db.query<{ receipt: { revision: number } }>("SELECT json_build_object('revision', revision) AS receipt FROM purama_ai.subscriptions")).rows[0].receipt.revision;
    expect(value).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(value)).toBe(true);
    await expect(db.exec("UPDATE purama_ai.subscriptions SET status='canceled'")).rejects.toThrow('revision exhausted');
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back the revision together with a failed or aborted business write', async () => {
    await seed(); const before = await snapshot();
    await db.exec('BEGIN');
    try {
      await db.exec("UPDATE purama_ai.subscriptions SET stripe_subscription_id='sub_next', status='canceled'");
      expect((await snapshot())[0].revision).toBe('1');
    } finally { await db.exec('ROLLBACK'); }
    expect(await snapshot()).toEqual(before);
  });

  it('does not let a snapshot of a deleted row apply to a new row with a reset revision', async () => {
    const old = await seed();
    await db.query('DELETE FROM purama_ai.subscriptions WHERE id=$1', [old.id]);
    const current = await seed();
    expect(current.id).not.toBe(old.id);
    expect((await db.query(`UPDATE purama_ai.subscriptions SET status='past_due'
      WHERE id=$1 AND revision=$2::bigint RETURNING id`, [old.id, old.revision])).rows).toEqual([]);
    expect((await snapshot())[0]).toMatchObject({ id: current.id, status: 'active', revision: '0' });
  });
});
