import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const originalMigration = source('supabase/migrations/20260727020000_overage_credits.sql');
const migration = source('supabase/migrations/20261110000200_overage_credit_idempotency.sql');
const compile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const helperCode = compile(source('supabase/functions/stripe-webhook/overage.ts'));
const handlerCode = compile(source('supabase/functions/stripe-webhook/index.ts'));
const owner = '00000000-0000-4000-8000-000000000101';
const other = '00000000-0000-4000-8000-000000000102';
const confirmedAt = Math.floor(Date.parse('2026-10-31T23:59:00Z') / 1000);
type Parameters = Record<string, unknown>;
type Handler = (request: Request) => Promise<Response>;
type Receipt = { credited: boolean; credit_id: string; period_start: string };
const rpcSql = `SELECT purama_ai.credit_overage_pack(
  $1::uuid, $2::text, $3::text, $4::text, $5::timestamptz,
  $6::bigint, $7::text, $8::boolean, $9::integer
) AS receipt`;
const parameterKeys = [
  'p_user_id', 'p_stripe_session_id', 'p_stripe_payment_intent_id', 'p_stripe_event_id',
  'p_payment_confirmed_at', 'p_payment_amount_total', 'p_payment_currency', 'p_payment_livemode', 'p_actions',
];

function paymentEvent(type = 'checkout.session.completed') {
  return {
    id: 'evt_confirmed_fixture', type, created: confirmedAt, livemode: false,
    data: { object: {
      id: 'cs_test_overage_fixture', mode: 'payment', status: 'complete', payment_status: 'paid',
      created: confirmedAt - 3600, livemode: false, payment_intent: 'pi_fixture',
      amount_total: 1900, currency: 'eur', metadata: { type: 'overage_pack', user_id: owner },
    } },
  };
}

function creditParameters(patch: Parameters = {}): Parameters {
  return {
    p_user_id: owner, p_stripe_session_id: 'cs_test_overage_fixture',
    p_stripe_payment_intent_id: 'pi_fixture', p_stripe_event_id: 'evt_confirmed_fixture',
    p_payment_confirmed_at: new Date(confirmedAt * 1000).toISOString(),
    p_payment_amount_total: 1900, p_payment_currency: 'eur', p_payment_livemode: false, p_actions: 2000,
    ...patch,
  };
}

async function database(applyCorrection = true): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE public_only;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA purama_ai;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    GRANT USAGE ON SCHEMA auth, purama_ai TO anon, authenticated, public_only, service_role;
  `);
  await db.exec(originalMigration);
  await db.query('INSERT INTO auth.users (id) VALUES ($1), ($2)', [owner, other]);
  // Model the existing broad table grants; RLS and explicit RPC grants must still
  // prevent clients from assigning credits to themselves.
  await db.exec('GRANT ALL ON purama_ai.overage_credits TO anon, authenticated, service_role');
  if (applyCorrection) await db.exec(migration);
  return db;
}

async function credit(db: PGlite, parameters: Parameters, role = 'service_role'): Promise<Receipt> {
  return db.transaction(async tx => {
    // role is a closed test fixture, never request data.
    if (!['service_role', 'anon', 'authenticated', 'public_only'].includes(role)) throw new Error('Unexpected fixture role');
    await tx.exec(`SET LOCAL ROLE ${role}`);
    const result = await tx.query<{ receipt: Receipt }>(rpcSql, parameterKeys.map(key => parameters[key]));
    return result.rows[0].receipt;
  });
}

async function snapshot(db: PGlite) {
  return (await db.query(`SELECT id::text, user_id::text, actions, period_start::text, stripe_session_id,
    stripe_payment_intent_id, stripe_event_id, payment_confirmed_at::text,
    payment_amount_total::text, payment_currency, payment_livemode
    FROM purama_ai.overage_credits ORDER BY id`)).rows;
}

function harness(db: PGlite) {
  const state: {
    event: unknown; failuresRemaining: number; missingReceiptsRemaining: number; calls: Parameters[];
  } = { event: paymentEvent(), failuresRemaining: 0, missingReceiptsRemaining: 0, calls: [] };
  const helperExports: Record<string, unknown> = {};
  new Function('exports', helperCode)(helperExports);
  let handler: Handler | undefined;
  class StripeFixture {
    static createFetchHttpClient() { return null; }
    static createSubtleCryptoProvider() { return null; }
    webhooks = { constructEventAsync: async (_body: string, signature: string) => {
      if (signature !== 'fixture-valid') throw new Error('invalid fixture signature');
      return state.event;
    } };
  }
  const createClient = () => ({
    rpc: async (name: string, parameters: Parameters) => {
      if (name !== 'credit_overage_pack') throw new Error(`Unexpected RPC ${name}`);
      state.calls.push(parameters);
      if (state.failuresRemaining-- > 0) return { data: null, error: { message: 'temporary_database_failure' } };
      try {
        const data = await credit(db, parameters);
        if (state.missingReceiptsRemaining-- > 0) return { data: null, error: null };
        return { data, error: null };
      } catch (error) {
        return { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
      }
    },
    from: () => { throw new Error('Overage must use its atomic SQL boundary, not direct table writes'); },
  });
  const require = (name: string): unknown => {
    if (name === 'https://deno.land/std@0.190.0/http/server.ts') return { serve: (value: Handler) => { handler = value; } };
    if (name === 'https://esm.sh/stripe@18.5.0') return { default: StripeFixture };
    if (name === 'https://esm.sh/@supabase/supabase-js@2.91.0') return { createClient };
    if (name === 'https://esm.sh/resend@2.0.0') return { Resend: class { constructor() { throw new Error('Unexpected email side effect'); } } };
    if (name === './overage.ts') return helperExports;
    throw new Error(`Unexpected remote import ${name}`);
  };
  const env: Record<string, string> = {
    STRIPE_SECRET_KEY: 'fixture-not-a-secret', STRIPE_WEBHOOK_SECRET: 'fixture-not-a-secret',
    SUPABASE_URL: 'https://fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fixture-not-a-secret',
  };
  // Execute the complete, real handler. Only runtime/provider boundaries are
  // replaced; writes run through the real PostgreSQL function and constraints.
  // No socket, provider account, payment, email or network permission is used.
  new Function('require', 'exports', 'Deno', 'fetch', 'console', handlerCode)(
    require, {}, { env: { get: (key: string) => env[key] } },
    () => { throw new Error('Network calls forbidden in isolated test'); }, { log() {}, error() {} },
  );
  if (!handler) throw new Error('Webhook handler was not registered');
  return { state, handle: handler };
}

function request(signature: string | null = 'fixture-valid') {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (signature !== null) headers.set('stripe-signature', signature);
  return new Request('https://fixture.invalid/stripe-webhook', { method: 'POST', headers, body: '{}' });
}

describe('legacy overage: real webhook and PostgreSQL credit boundary', () => {
  let db: PGlite;
  beforeAll(async () => { db = await database(); });
  beforeEach(async () => { await db.exec('TRUNCATE purama_ai.overage_credits'); });
  afterAll(async () => { await db?.close(); });

  it('credits a confirmed session once and retains the signed payment month on redelivery', async () => {
    const h = harness(db);
    expect((await h.handle(request())).status).toBe(200);
    const before = await snapshot(db);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ user_id: owner, actions: 2000, period_start: '2026-10-01', payment_amount_total: '1900' });
    expect((await h.handle(request())).status).toBe(200);
    expect(await snapshot(db)).toEqual(before);
  });

  it('serializes a burst of deliveries into one credit under the real SQL unique constraint', async () => {
    const h = harness(db);
    const responses = await Promise.all(Array.from({ length: 12 }, () => h.handle(request())));
    expect(responses.map(response => response.status)).toEqual(Array(12).fill(200));
    expect(await snapshot(db)).toHaveLength(1);
    // PGlite is a single backend: this tests concurrent handler delivery against
    // the SQL boundary, not native PostgreSQL multi-session lock scheduling.
  });

  it.each(['unpaid', 'no_payment_required'])('does not grant completed Checkout credits with %s status', async paymentStatus => {
    const h = harness(db); const event = paymentEvent(); event.data.object.payment_status = paymentStatus;
    h.state.event = event;
    expect((await h.handle(request())).status).toBe(200);
    expect(h.state.calls).toEqual([]);
    expect(await snapshot(db)).toEqual([]);
  });

  it('waits for delayed payment success and grants once in the successful event month', async () => {
    const h = harness(db); const pending = paymentEvent(); pending.data.object.payment_status = 'unpaid';
    h.state.event = pending;
    expect((await h.handle(request())).status).toBe(200);
    const paid = paymentEvent('checkout.session.async_payment_succeeded');
    paid.id = 'evt_async_paid'; paid.created = confirmedAt + 120;
    h.state.event = paid;
    expect((await h.handle(request())).status).toBe(200);
    expect((await h.handle(request())).status).toBe(200);
    expect(await snapshot(db)).toHaveLength(1);
    expect((await snapshot(db))[0]).toMatchObject({ period_start: '2026-11-01', stripe_event_id: 'evt_async_paid' });
  });

  it('does not acknowledge an inconsistent delayed success as a credit', async () => {
    const h = harness(db); const event = paymentEvent('checkout.session.async_payment_succeeded');
    event.data.object.payment_status = 'unpaid'; h.state.event = event;
    expect((await h.handle(request())).status).toBe(500);
    expect(h.state.calls).toEqual([]);
    expect(await snapshot(db)).toEqual([]);
  });

  it('ignores delayed failures and unrelated async sessions without issuing credits', async () => {
    const h = harness(db);
    h.state.event = paymentEvent('checkout.session.async_payment_failed');
    expect((await h.handle(request())).status).toBe(200);
    const event = paymentEvent('checkout.session.async_payment_succeeded'); event.data.object.metadata.type = 'other_product';
    h.state.event = event;
    expect((await h.handle(request())).status).toBe(200);
    expect(h.state.calls).toEqual([]);
  });

  it.each([null, 'fixture-invalid'])('requires signature verification before crediting: %s', async signature => {
    const h = harness(db);
    expect((await h.handle(request(signature))).status).toBe(400);
    expect(h.state.calls).toEqual([]);
  });

  it.each([
    ['invalid owner', (event: ReturnType<typeof paymentEvent>) => { event.data.object.metadata.user_id = 'not-a-uuid'; }],
    ['missing payment intent', (event: ReturnType<typeof paymentEvent>) => { event.data.object.payment_intent = ''; }],
    ['invalid amount', (event: ReturnType<typeof paymentEvent>) => { event.data.object.amount_total = 0; }],
    ['fractional amount', (event: ReturnType<typeof paymentEvent>) => { event.data.object.amount_total = 19.5; }],
    ['invalid currency', (event: ReturnType<typeof paymentEvent>) => { event.data.object.currency = ''; }],
    ['incomplete session', (event: ReturnType<typeof paymentEvent>) => { event.data.object.status = 'open'; }],
    ['missing timestamp', (event: ReturnType<typeof paymentEvent>) => { event.created = 0; }],
    ['time before creation', (event: ReturnType<typeof paymentEvent>) => { event.created = event.data.object.created - 1; }],
    ['mode mismatch', (event: ReturnType<typeof paymentEvent>) => { event.livemode = true; }],
  ] as const)('rejects %s before any persistent credit', async (_name, alter) => {
    const h = harness(db); const event = paymentEvent(); alter(event); h.state.event = event;
    expect((await h.handle(request())).status).toBe(500);
    expect(h.state.calls).toEqual([]);
    expect(await snapshot(db)).toEqual([]);
  });

  it('supports an expanded payment intent without trusting its other fields', async () => {
    const h = harness(db); const event = paymentEvent();
    h.state.event = { ...event, data: { object: { ...event.data.object, payment_intent: { id: 'pi_fixture' } } } };
    expect((await h.handle(request())).status).toBe(200);
    expect(await snapshot(db)).toHaveLength(1);
  });

  it('returns a retryable error on persistence failure and grants once on retry', async () => {
    const h = harness(db); h.state.failuresRemaining = 1;
    expect((await h.handle(request())).status).toBe(500);
    expect(await snapshot(db)).toEqual([]);
    expect((await h.handle(request())).status).toBe(200);
    expect(await snapshot(db)).toHaveLength(1);
  });

  it('requires a persisted receipt and safely retries after a lost acknowledgement', async () => {
    const h = harness(db); h.state.missingReceiptsRemaining = 1;
    expect((await h.handle(request())).status).toBe(500);
    const before = await snapshot(db);
    expect(before).toHaveLength(1);
    expect((await h.handle(request())).status).toBe(200);
    expect(await snapshot(db)).toEqual(before);
  });

  it('rejects reuse of a session for another user through the real webhook', async () => {
    const h = harness(db);
    expect((await h.handle(request())).status).toBe(200);
    const before = await snapshot(db);
    const event = paymentEvent(); event.data.object.metadata.user_id = other; h.state.event = event;
    expect((await h.handle(request())).status).toBe(500);
    expect(await snapshot(db)).toEqual(before);
  });

  it.each([
    { p_actions: 2001 }, { p_payment_amount_total: 1800 }, { p_payment_currency: 'usd' },
    { p_stripe_payment_intent_id: 'pi_other' }, { p_payment_livemode: true },
    { p_payment_confirmed_at: '2026-11-01T00:00:01Z' },
  ])('rejects a conflicting session payload atomically: %j', async patch => {
    await credit(db, creditParameters());
    const before = await snapshot(db);
    await expect(credit(db, creditParameters(patch))).rejects.toThrow('overage_session_conflict_requires_reconciliation');
    expect(await snapshot(db)).toEqual(before);
  });

  it('accepts another event ID for the same evidenced payment without replacing its first receipt', async () => {
    const first = await credit(db, creditParameters());
    const before = await snapshot(db);
    const second = await credit(db, creditParameters({ p_stripe_event_id: 'evt_another_delivery' }));
    expect(second).toEqual({ ...first, credited: false });
    expect(await snapshot(db)).toEqual(before);
  });

  it('rejects reusing a payment event for a different session, including crossed existing receipts', async () => {
    await credit(db, creditParameters());
    const before = await snapshot(db);
    await expect(credit(db, creditParameters({ p_stripe_session_id: 'cs_test_another' })))
      .rejects.toThrow('overage_session_conflict_requires_reconciliation');
    expect(await snapshot(db)).toEqual(before);

    await credit(db, creditParameters({
      p_stripe_session_id: 'cs_test_another', p_stripe_payment_intent_id: 'pi_another',
      p_stripe_event_id: 'evt_another_first_receipt',
    }));
    const twoReceipts = await snapshot(db);
    await expect(credit(db, creditParameters({ p_stripe_event_id: 'evt_another_first_receipt' })))
      .rejects.toThrow('overage_session_conflict_requires_reconciliation');
    expect(await snapshot(db)).toEqual(twoReceipts);
  });

  it.each(['anon', 'authenticated', 'public_only'])('forbids credit RPC access from %s', async role => {
    await expect(credit(db, creditParameters(), role)).rejects.toThrow(/permission denied/);
    expect(await snapshot(db)).toEqual([]);
  });

  it('cannot be bypassed by a client direct insert despite broad historical table grants', async () => {
    await expect(db.transaction(async tx => {
      await tx.exec('SET LOCAL ROLE authenticated');
      await tx.query("INSERT INTO purama_ai.overage_credits(user_id, actions, period_start, stripe_session_id) VALUES ($1, 2000, '2026-10-01', 'cs_test_forged')", [owner]);
    })).rejects.toThrow(/row-level security/);
    expect(await snapshot(db)).toEqual([]);
  });

  it('enforces session and event uniqueness for direct trusted inserts outside the helper', async () => {
    await credit(db, creditParameters());
    await expect(db.query("INSERT INTO purama_ai.overage_credits(user_id, actions, period_start, stripe_session_id) VALUES ($1, 2000, '2026-10-01', 'cs_test_overage_fixture')", [owner]))
      .rejects.toThrow(/unique constraint/);
    await expect(db.query("INSERT INTO purama_ai.overage_credits(user_id, actions, period_start, stripe_session_id, stripe_event_id) VALUES ($1, 2000, '2026-10-01', 'cs_test_direct_other', 'evt_confirmed_fixture')", [owner]))
      .rejects.toThrow(/unique constraint/);
    expect(await snapshot(db)).toHaveLength(1);
  });

  it('keeps historical credits intact and refuses to invent missing payment evidence on replay', async () => {
    await db.query("INSERT INTO purama_ai.overage_credits(user_id, actions, period_start, stripe_session_id) VALUES ($1, 2000, '2026-10-01', 'cs_test_overage_fixture')", [owner]);
    const before = await snapshot(db); const h = harness(db);
    expect((await h.handle(request())).status).toBe(500);
    expect(await snapshot(db)).toEqual(before);
  });

  it('can reapply the migration without changing credits or payment proof', async () => {
    await credit(db, creditParameters()); const before = await snapshot(db);
    await db.exec(migration);
    expect(await snapshot(db)).toEqual(before);
    expect(await credit(db, creditParameters())).toMatchObject({ credited: false });
  });
});

it('stops the migration on historical duplicate sessions without deleting or rewriting a credit', async () => {
  const db = await database(false);
  try {
    await db.query("INSERT INTO purama_ai.overage_credits(user_id, actions, period_start, stripe_session_id) VALUES ($1, 2000, '2026-10-01', 'cs_test_duplicate'), ($1, 2000, '2026-10-01', 'cs_test_duplicate')", [owner]);
    const before = (await db.query('SELECT * FROM purama_ai.overage_credits ORDER BY id')).rows;
    await expect(db.exec(migration)).rejects.toThrow('overage_duplicate_sessions_require_reconciliation');
    await db.exec('ROLLBACK');
    expect((await db.query('SELECT * FROM purama_ai.overage_credits ORDER BY id')).rows).toEqual(before);
    expect((await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'purama_ai' AND table_name = 'overage_credits' AND column_name = 'payment_confirmed_at'")).rows).toEqual([]);
  } finally { await db.close(); }
});
