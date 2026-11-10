import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { normalizeStripeReconciliationEvent } from "../../supabase/functions/_shared/stripe-reconciliation.ts";

// Test-only PostgreSQL/WASM engine, installed outside the application manifest.
// PGLITE_MODULE may name an existing absolute module path in a test runtime.
const { PGlite } = await import(
  process.env.PGLITE_MODULE || "@electric-sql/pglite"
);
let db;
const migration = await readFile(
  new URL(
    "../../supabase/migrations/20261110000200_stripe_reconciliation_events.sql",
    import.meta.url,
  ),
  "utf8",
);
const overageSchema = `
  CREATE TABLE purama_ai.subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
    stripe_customer_id text
  );
  CREATE TABLE purama_ai.overage_credits (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
    actions integer NOT NULL DEFAULT 2000, period_start date NOT NULL,
    stripe_session_id text, created_at timestamptz NOT NULL DEFAULT now()
  );
`;
const legacyCommission = {
  id: "legacy",
  sale_amount: "1188.00",
  commission_amount: "118.68",
  status: "validated",
};

before(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA purama_ai;
    GRANT USAGE ON SCHEMA purama_ai TO anon, authenticated, service_role;
    CREATE TABLE public.commissions (
      id text PRIMARY KEY, sale_amount numeric(10,2), commission_amount numeric(10,2), status text
    );
    INSERT INTO public.commissions VALUES ('legacy', 1188, 118.68, 'validated');
    ${overageSchema}
  `);
  await db.exec(migration);
});
after(async () => {
  await db?.close();
});

function observation(id, overrides = {}) {
  return normalizeStripeReconciliationEvent({
    id,
    type: "invoice.payment_succeeded",
    created: 1794254400,
    livemode: false,
    api_version: "2025-08-27.basil",
    data: {
      object: {
        id: "in_first",
        object: "invoice",
        status: "paid",
        amount_paid: 9950,
        amount_remaining: 0,
        currency: "eur",
        billing_reason: "subscription_create",
        parent: { subscription_details: { subscription: "sub_a" } },
      },
    },
    ...overrides,
  });
}

async function asRole(role, work) {
  assert(["anon", "authenticated", "service_role"].includes(role));
  await db.exec(`SET ROLE ${role}`);
  try {
    return await work();
  } finally {
    await db.exec("RESET ROLE");
  }
}
async function record(value) {
  const result = await db.query(
    "SELECT purama_ai.record_stripe_reconciliation_event($1::jsonb) AS receipt",
    [JSON.stringify(value)],
  );
  return result.rows[0].receipt;
}

test("service role receives acknowledgement only for an actually persisted row", async () => {
  const value = observation("evt_persist");
  const result = await asRole("service_role", () => record(value));
  assert.deepEqual(result, {
    recorded: true,
    event_id: "evt_persist",
    duplicate: false,
    reconciliation: "required",
  });
  const rows = await db.query(
    "SELECT source_facts, reconciliation FROM purama_ai.stripe_reconciliation_events WHERE event_id = $1",
    ["evt_persist"],
  );
  assert.deepEqual(rows.rows[0].source_facts, value.source_facts);
  assert.equal(rows.rows[0].reconciliation, "required");
});

test("identical retries produce one row; conflicting facts cannot overwrite it", async () => {
  const value = observation("evt_replay");
  await asRole("service_role", () => record(value));
  assert.equal(
    (await asRole("service_role", () => record(value))).duplicate,
    true,
  );
  const changed = structuredClone(value);
  changed.source_facts.money.amount_paid = 19900;
  await assert.rejects(
    asRole("service_role", () => record(changed)),
    /Conflicting Stripe event evidence/,
  );
  const result = await db.query(
    "SELECT source_facts FROM purama_ai.stripe_reconciliation_events WHERE event_id = $1",
    ["evt_replay"],
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].source_facts.money.amount_paid, 9950);
});

test("account and live/test context are part of durable uniqueness", async () => {
  for (
    const context of [{ account: "acct_a", livemode: false }, {
      account: "acct_b",
      livemode: false,
    }, { account: "acct_a", livemode: true }]
  ) {
    assert.equal(
      (await asRole(
        "service_role",
        () => record(observation("evt_scoped", context)),
      )).duplicate,
      false,
    );
  }
  const result = await db.query(
    "SELECT count(*)::int AS count FROM purama_ai.stripe_reconciliation_events WHERE event_id = $1",
    ["evt_scoped"],
  );
  assert.equal(result.rows[0].count, 3);
});

for (const role of ["anon", "authenticated"]) {
  test(`${role} cannot read, append or call the evidence writer`, async () => {
    await assert.rejects(
      asRole(
        role,
        () => db.query("SELECT * FROM purama_ai.stripe_reconciliation_events"),
      ),
      /permission denied/,
    );
    await assert.rejects(
      asRole(role, () => record(observation(`evt_${role}`))),
      /permission denied/,
    );
    await assert.rejects(
      asRole(role, () =>
        db.query(
          "INSERT INTO purama_ai.stripe_reconciliation_events (stripe_account_key) VALUES ('forged')",
        )),
      /permission denied/,
    );
  });
}

test("service role cannot bypass the writer or edit/delete historical evidence", async () => {
  await assert.rejects(
    asRole("service_role", () =>
      db.query(
        "INSERT INTO purama_ai.stripe_reconciliation_events (stripe_account_key) VALUES ('forged')",
      )),
    /permission denied/,
  );
  await assert.rejects(
    asRole("service_role", () =>
      db.query(
        "UPDATE purama_ai.stripe_reconciliation_events SET source_facts = '{}'",
      )),
    /permission denied/,
  );
  await assert.rejects(
    asRole(
      "service_role",
      () => db.query("DELETE FROM purama_ai.stripe_reconciliation_events"),
    ),
    /permission denied/,
  );
  assert(
    (await asRole(
      "service_role",
      () =>
        db.query("SELECT event_id FROM purama_ai.stripe_reconciliation_events"),
    ))
      .rows.length > 0,
  );
});

test("transaction rollback leaves no false acknowledgement record and a retry can succeed", async () => {
  const value = observation("evt_rollback");
  await db.exec("BEGIN");
  await record(value);
  await db.exec("ROLLBACK");
  assert.equal(
    (await db.query(
      "SELECT event_id FROM purama_ai.stripe_reconciliation_events WHERE event_id = $1",
      ["evt_rollback"],
    )).rows.length,
    0,
  );
  assert.equal(
    (await asRole("service_role", () => record(value))).duplicate,
    false,
  );
});

test("several duplicate calls retain a single observation", async () => {
  const value = observation("evt_many");
  const receipts = await Promise.all(
    Array.from({ length: 12 }, () => record(value)),
  );
  assert.equal(receipts.filter((receipt) => !receipt.duplicate).length, 1);
  assert.equal(
    (await db.query(
      "SELECT event_id FROM purama_ai.stripe_reconciliation_events WHERE event_id = $1",
      ["evt_many"],
    )).rows.length,
    1,
  );
});

test("initial invoice and renewals are retained independently without subscription uniqueness collision", async () => {
  for (let i = 0; i < 3; i++) {
    const value = observation(`evt_cycle_${i}`);
    value.object_id = `in_cycle_${i}`;
    value.source_facts.invoice_id = value.object_id;
    value.source_facts.billing_reason = i
      ? "subscription_cycle"
      : "subscription_create";
    await record(value);
  }
  const result = await db.query(
    "SELECT count(*)::int AS count FROM purama_ai.stripe_reconciliation_events WHERE event_id LIKE 'evt_cycle_%'",
  );
  assert.equal(result.rows[0].count, 3);
});

test("partial/full refunds and failed refunds keep provider amounts and statuses without rewriting rights", async () => {
  for (
    const [id, amount, status] of [["evt_refund_partial", 2500, "succeeded"], [
      "evt_refund_full",
      9950,
      "succeeded",
    ], ["evt_refund_failed", 1000, "failed"]]
  ) {
    await record(observation(id, {
      type: "refund.updated",
      data: {
        object: {
          id: `re_${id}`,
          object: "refund",
          charge: "ch_a",
          payment_intent: "pi_a",
          amount,
          currency: "eur",
          status,
        },
      },
    }));
  }
  const result = await db.query(
    "SELECT source_facts FROM purama_ai.stripe_reconciliation_events WHERE event_id LIKE 'evt_refund_%' ORDER BY event_id",
  );
  assert.deepEqual(
    result.rows.map((
      row,
    ) => [row.source_facts.money.amount, row.source_facts.status]),
    [[1000, "failed"], [9950, "succeeded"], [2500, "succeeded"]],
  );
  assert.deepEqual((await db.query("SELECT * FROM public.commissions")).rows, [
    legacyCommission,
  ]);
});

test("malformed and excessively large envelopes fail atomically", async () => {
  for (
    const bad of [
      null,
      {},
      { ...observation("evt_invalid"), livemode: "false" },
      { ...observation("evt_invalid"), event_created: -1 },
      {
        ...observation("evt_invalid"),
        source_facts: { payload: "x".repeat(140000) },
      },
    ]
  ) {
    await assert.rejects(
      asRole("service_role", () => record(bad)),
      /Invalid Stripe reconciliation envelope/,
    );
  }
  assert.equal(
    (await db.query(
      "SELECT event_id FROM purama_ai.stripe_reconciliation_events WHERE event_id = 'evt_invalid'",
    )).rows.length,
    0,
  );
});

test("migration and event processing preserve all old commission values and statuses", async () => {
  assert.deepEqual((await db.query("SELECT * FROM public.commissions")).rows, [
    legacyCommission,
  ]);
});

const packUser = "00000000-0000-4000-8000-000000000001";
function packEvent(id, sessionId, overrides = {}) {
  return observation(id, {
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        mode: "payment",
        payment_status: "paid",
        metadata: { user_id: packUser, type: "overage_pack" },
        ...overrides,
      },
    },
  });
}
async function applyPack(id, mode = false) {
  const result = await db.query(
    "SELECT purama_ai.apply_stripe_overage_credit($1, $2) AS receipt",
    [id, mode],
  );
  return result.rows[0].receipt;
}

test("paid pack credits exactly once across event retries and different event IDs for one session", async () => {
  await record(packEvent("evt_pack_first", "cs_sql_pack"));
  const asyncEvent = packEvent("evt_pack_async", "cs_sql_pack");
  asyncEvent.event_type = "checkout.session.async_payment_succeeded";
  await record(asyncEvent);
  const receipt = await asRole(
    "service_role",
    () => applyPack("evt_pack_first"),
  );
  assert.deepEqual(receipt, {
    credited: true,
    session_id: "cs_sql_pack",
    duplicate: false,
  });
  const replay = await Promise.all(
    Array.from(
      { length: 8 },
      (_, i) => applyPack(i % 2 ? "evt_pack_async" : "evt_pack_first"),
    ),
  );
  assert(replay.every((value) => value.duplicate));
  const credits = await db.query(
    "SELECT user_id, actions FROM purama_ai.overage_credits WHERE stripe_session_id = 'cs_sql_pack'",
  );
  assert.deepEqual(credits.rows, [{ user_id: packUser, actions: 2000 }]);
});

test("unpaid or missing overage proof cannot create a credit", async () => {
  for (
    const [id, patch] of [["evt_pack_unpaid", { payment_status: "unpaid" }], [
      "evt_pack_no_user",
      { metadata: { type: "overage_pack" } },
    ], ["evt_pack_wrong_mode", { mode: "subscription" }]]
  ) {
    await record(packEvent(id, `cs_${id}`, patch));
    await assert.rejects(
      asRole("service_role", () => applyPack(id)),
      /Paid Stripe overage evidence/,
    );
  }
  await assert.rejects(
    asRole("service_role", () => applyPack("evt_pack_absent")),
    /query returned no rows/,
  );
  const connected = packEvent("evt_pack_connected", "cs_connected");
  connected.stripe_account_key = "acct_a";
  await record(connected);
  await assert.rejects(
    asRole("service_role", () => applyPack("evt_pack_connected")),
    /query returned no rows/,
  );
  assert.equal(
    (await db.query(
      "SELECT id FROM purama_ai.overage_credits WHERE stripe_session_id = 'cs_connected'",
    )).rows.length,
    0,
  );
});

for (const role of ["anon", "authenticated"]) {
  test(`${role} cannot call the pack writer`, async () => {
    await assert.rejects(
      asRole(role, () => applyPack("evt_pack_first")),
      /permission denied/,
    );
  });
}

test("economic uniqueness also rejects an old writer trying to insert the same session", async () => {
  await assert.rejects(
    db.query(
      "INSERT INTO purama_ai.overage_credits (user_id, actions, period_start, stripe_session_id) VALUES ($1, 2000, current_date, 'cs_sql_pack')",
      [packUser],
    ),
    /duplicate key/,
  );
});

test("historical matching credit keeps its original month and is never credited again", async () => {
  await db.query(
    "INSERT INTO purama_ai.overage_credits (user_id, actions, period_start, stripe_session_id) VALUES ($1, 2000, '2026-10-01', 'cs_old_credit')",
    [packUser],
  );
  await record(packEvent("evt_old_credit", "cs_old_credit"));
  assert.equal((await applyPack("evt_old_credit")).duplicate, true);
  assert.deepEqual(
    (await db.query(
      "SELECT period_start::text, actions FROM purama_ai.overage_credits WHERE stripe_session_id = 'cs_old_credit'",
    )).rows,
    [{ period_start: "2026-10-01", actions: 2000 }],
  );
});

test("conflicting historical beneficiary or number of actions fails without changing old rights", async () => {
  for (
    const [session, user, actions] of [[
      "cs_wrong_owner",
      "00000000-0000-4000-8000-000000000002",
      2000,
    ], ["cs_wrong_actions", packUser, 1000]]
  ) {
    await db.query(
      "INSERT INTO purama_ai.overage_credits (user_id, actions, period_start, stripe_session_id) VALUES ($1, $2, current_date, $3)",
      [user, actions, session],
    );
    await record(packEvent(`evt_${session}`, session));
    await assert.rejects(
      applyPack(`evt_${session}`),
      /Conflicting historical overage credit/,
    );
    assert.deepEqual(
      (await db.query(
        "SELECT user_id, actions FROM purama_ai.overage_credits WHERE stripe_session_id = $1",
        [session],
      )).rows,
      [{ user_id: user, actions }],
    );
  }
});

test("pack credit transaction rollback is retryable without a false durable result", async () => {
  await record(packEvent("evt_pack_rollback", "cs_rollback"));
  await db.exec("BEGIN");
  await applyPack("evt_pack_rollback");
  await db.exec("ROLLBACK");
  assert.equal(
    (await db.query(
      "SELECT id FROM purama_ai.overage_credits WHERE stripe_session_id = 'cs_rollback'",
    )).rows.length,
    0,
  );
  assert.equal((await applyPack("evt_pack_rollback")).duplicate, false);
});

test("migration with existing duplicate credits rolls back and preserves both historical rows", async () => {
  const legacyDb = new PGlite();
  try {
    await legacyDb.exec(
      `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA purama_ai; ${overageSchema}`,
    );
    await legacyDb.query(
      "INSERT INTO purama_ai.overage_credits (user_id, actions, period_start, stripe_session_id) VALUES ($1, 2000, '2026-10-01', 'cs_duplicate'), ($1, 2000, '2026-10-01', 'cs_duplicate')",
      [packUser],
    );
    await assert.rejects(
      legacyDb.exec(migration),
      /Duplicate historical Stripe overage credits/,
    );
    await legacyDb.exec("ROLLBACK");
    assert.equal(
      (await legacyDb.query(
        "SELECT to_regclass('purama_ai.stripe_reconciliation_events') AS table_name",
      )).rows[0].table_name,
      null,
    );
    assert.equal(
      (await legacyDb.query(
        "SELECT count(*)::int AS count FROM purama_ai.overage_credits",
      )).rows[0].count,
      2,
    );
  } finally {
    await legacyDb.close();
  }
});

test("customer binding uniqueness permits unbound users but rejects another owner of one Stripe customer", async () => {
  await db.exec(
    "INSERT INTO purama_ai.subscriptions (user_id, stripe_customer_id) VALUES ('00000000-0000-4000-8000-000000000001', null), ('00000000-0000-4000-8000-000000000002', null)",
  );
  await db.exec(
    "UPDATE purama_ai.subscriptions SET stripe_customer_id = 'cus_unique' WHERE user_id = '00000000-0000-4000-8000-000000000001'",
  );
  await assert.rejects(
    db.exec(
      "UPDATE purama_ai.subscriptions SET stripe_customer_id = 'cus_unique' WHERE user_id = '00000000-0000-4000-8000-000000000002'",
    ),
    /duplicate key/,
  );
  assert.equal(
    (await db.query(
      "SELECT stripe_customer_id FROM purama_ai.subscriptions WHERE user_id = '00000000-0000-4000-8000-000000000002'",
    )).rows[0].stripe_customer_id,
    null,
  );
});

test("duplicate historical customer binding aborts the entire migration without picking an owner", async () => {
  const legacyDb = new PGlite();
  try {
    await legacyDb.exec(
      `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA purama_ai; ${overageSchema}`,
    );
    await legacyDb.exec(
      "INSERT INTO purama_ai.subscriptions (user_id, stripe_customer_id) VALUES ('00000000-0000-4000-8000-000000000001', 'cus_ambiguous'), ('00000000-0000-4000-8000-000000000002', 'cus_ambiguous')",
    );
    await assert.rejects(
      legacyDb.exec(migration),
      /Duplicate historical Stripe customer bindings/,
    );
    await legacyDb.exec("ROLLBACK");
    assert.equal(
      (await legacyDb.query(
        "SELECT to_regclass('purama_ai.stripe_reconciliation_events') AS table_name",
      )).rows[0].table_name,
      null,
    );
    assert.equal(
      (await legacyDb.query(
        "SELECT to_regclass('purama_ai.overage_credits_stripe_session_unique') AS index_name",
      )).rows[0].index_name,
      null,
    );
    assert.equal(
      (await legacyDb.query(
        "SELECT count(*)::int AS count FROM purama_ai.subscriptions WHERE stripe_customer_id = 'cus_ambiguous'",
      )).rows[0].count,
      2,
    );
  } finally {
    await legacyDb.close();
  }
});
