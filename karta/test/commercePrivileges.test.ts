import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const historical = [
  "supabase/migrations/20260122152902_ec0f2a0a-f327-4f43-88ee-e867cf4d1995.sql",
  "supabase/migrations/20260122235510_766a8ba1-97fb-4567-8b4b-7acb02073bd7.sql",
  "supabase/migrations/20260123003417_746171fd-e667-4de4-8c28-fb7473a4a8a6.sql",
  "supabase/migrations/20260123003822_5bd584df-38a4-460c-8938-bce168706e63.sql",
  "p3_schema.sql",
  "supabase/migrations/20260422180000_v4_1_stripe_connect_opentimestamps.sql",
].map(source);
const hardening = source("supabase/migrations/20261110000100_commerce_privileges.sql");
const ownId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const adminId = "00000000-0000-4000-8000-000000000003";
const newId = "00000000-0000-4000-8000-000000000004";
const influencerId = "10000000-0000-4000-8000-000000000001";
const otherInfluencerId = "10000000-0000-4000-8000-000000000002";
type ClientRole = "anon" | "authenticated" | "audit_public_only";
type Role = ClientRole | "service_role";
const clientRoles: ClientRole[] = ["anon", "authenticated", "audit_public_only"];

// These are two explicit schema-placement fixtures, not a claim about a deployed
// database. Both start from the unmodified historical SQL. The second moves the
// same relations because the current application addresses purama_ai, while the
// historical influencer migration creates public relations.
describe.each(["public", "purama_ai"] as const)("commerce ACLs with influencers in %s", (schema) => {
  let db: PGlite;
  let baseline: Record<string, unknown>;
  let publicLedgerDefinition: unknown[];
  const influencers = `${schema}.influencers`;
  const commissions = `${schema}.commissions`;
  const ledgers = [commissions, "purama_ai.wallets", "purama_ai.wallet_transactions"];
  const allTables = [influencers, ...ledgers, "purama_ai.withdrawals"];

  async function asRole<T>(role: Role, userId: string | null, work: () => Promise<T>): Promise<T> {
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""]);
    await db.exec(`SET ROLE ${role}`);
    try { return await work(); }
    finally {
      await db.exec("RESET ROLE");
      await db.query("SELECT set_config('request.jwt.claim.sub', '', false)");
    }
  }

  async function resetRows(): Promise<void> {
    await db.exec(`TRUNCATE ${influencers}, ${commissions}, purama_ai.wallets,
      purama_ai.wallet_transactions, purama_ai.withdrawals CASCADE`);
  }

  async function snapshot(): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (const table of allTables) {
      rows.push((await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows);
    }
    return rows;
  }

  beforeAll(async () => {
    db = new PGlite();
    // Supabase identity/role infrastructure only. Business tables, RLS, checks,
    // defaults and triggers below are executed from their real source files.
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE audit_public_only;
      CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE SCHEMA purama_ai;
      CREATE TABLE auth.users (
        id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb
      );
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      GRANT USAGE ON SCHEMA public, purama_ai, auth
        TO anon, authenticated, audit_public_only, service_role;
    `);
    for (const sql of historical) await db.exec(sql);
    if (schema === "purama_ai") {
      await db.exec(`ALTER TABLE public.influencers SET SCHEMA purama_ai;
        ALTER TABLE public.commissions SET SCHEMA purama_ai`);
    }
    // April agent migrations grant ALL on purama_ai to anon/authenticated.
    // Also model PUBLIC and direct column ACLs explicitly: revoking only the
    // table grant must not leave a second path through inherited column grants.
    for (const table of allTables) {
      await db.exec(`GRANT ALL ON TABLE ${table} TO PUBLIC, anon, authenticated, service_role`);
    }
    await db.exec(`
      GRANT INSERT (commission_rate), UPDATE (commission_rate)
        ON ${influencers} TO PUBLIC, anon, authenticated;
      GRANT INSERT (status), UPDATE (status)
        ON ${commissions} TO PUBLIC, anon, authenticated;
      GRANT INSERT (balance), UPDATE (balance)
        ON purama_ai.wallets TO PUBLIC, anon, authenticated;
      GRANT INSERT (amount), UPDATE (amount)
        ON purama_ai.wallet_transactions TO PUBLIC, anon, authenticated;
      GRANT INSERT (status), UPDATE (status)
        ON purama_ai.withdrawals TO PUBLIC, anon, authenticated;
      GRANT SELECT ON public.wallet_transactions TO authenticated;
    `);
    publicLedgerDefinition = (await db.query(`SELECT c.relacl::text,
      (SELECT jsonb_agg(jsonb_build_object('name', a.attname, 'type', a.atttypid)
        ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = c.oid
        AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
      (SELECT jsonb_agg(jsonb_build_object('name', p.polname, 'cmd', p.polcmd,
        'using', pg_get_expr(p.polqual, p.polrelid))) FROM pg_policy p
        WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c WHERE c.oid = 'public.wallet_transactions'::regclass`)).rows;
    for (const id of [ownId, otherId, adminId, newId]) {
      await db.query("INSERT INTO auth.users (id, email) VALUES ($1, $2)", [id, `${id}@example.test`]);
    }
    await db.query("INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')", [adminId]);

    await asRole("authenticated", ownId, async () => {
      await db.query(`INSERT INTO ${influencers}
        (id, user_id, promo_code, affiliation_link, commission_rate, total_sales, contract_status)
        VALUES ($1, $2, 'AUDIT', 'https://example.test/?ref=AUDIT', 99.99, 1000, 'signed')`,
      [influencerId, ownId]);
      await db.query(`INSERT INTO purama_ai.wallets (user_id, balance, total_earned)
        VALUES ($1, 100000, 100000)`, [ownId]);
      await db.query(`INSERT INTO purama_ai.withdrawals
        (user_id, amount, iban, beneficiary_name, status)
        VALUES ($1, 99999, 'TEST-IBAN', 'Audit', 'completed')`, [ownId]);
    });
    await asRole("authenticated", adminId, () => db.query(`INSERT INTO ${commissions}
      (influencer_id, client_id, sale_amount, commission_amount, status)
      VALUES ($1, $2, 100, 30, 'paid')`, [influencerId, otherId]));
    baseline = {
      influencer: (await db.query(`SELECT commission_rate::text, total_sales, contract_status FROM ${influencers}`)).rows[0],
      wallet: (await db.query("SELECT balance::text FROM purama_ai.wallets")).rows[0],
      withdrawal: (await db.query("SELECT amount::text, status FROM purama_ai.withdrawals")).rows[0],
      commission: (await db.query(`SELECT status FROM ${commissions}`)).rows[0],
    };
    await resetRows();
    await db.exec(hardening);
  });

  beforeEach(async () => {
    await resetRows();
    for (const [id, userId, code] of [[influencerId, ownId, "OWN"], [otherInfluencerId, otherId, "OTHER"]]) {
      await db.query(`INSERT INTO ${influencers} (id, user_id, promo_code, affiliation_link)
        VALUES ($1, $2, $3, $4)`, [id, userId, code, `https://example.test/?ref=${code}`]);
      await db.query(`INSERT INTO ${commissions}
        (influencer_id, client_id, sale_amount, commission_amount, status)
        VALUES ($1, $2, 100, 30, 'validated')`, [id, userId]);
      await db.query("INSERT INTO purama_ai.wallets (user_id, balance) VALUES ($1, 20)", [userId]);
      await db.query(`INSERT INTO purama_ai.wallet_transactions (user_id, amount, type, source)
        VALUES ($1, 20, 'credit', 'audit-fixture')`, [userId]);
      await db.query(`INSERT INTO purama_ai.withdrawals (user_id, amount, iban, beneficiary_name)
        VALUES ($1, 5, 'TEST-IBAN', 'Audit')`, [userId]);
    }
  });

  afterAll(async () => { await db?.close(); });

  it("reproduces the financial mutations permitted by the historical SQL", () => {
    expect(baseline).toEqual({
      influencer: { commission_rate: "99.99", total_sales: 1000, contract_status: "signed" },
      wallet: { balance: "100000.00" },
      withdrawal: { amount: "99999.00", status: "completed" },
      commission: { status: "paid" },
    });
  });

  it.each(clientRoles)("removes table and column ledger writes for %s", async (role) => {
    for (const table of ledgers) {
      const access = await db.query<{ table_write: boolean; column_write: boolean }>(`
        SELECT has_table_privilege($1, $2, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS table_write,
          has_any_column_privilege($1, $2, 'INSERT,UPDATE,REFERENCES') AS column_write`, [role, table]);
      expect(access.rows).toEqual([{ table_write: false, column_write: false }]);
    }
  });

  it.each(clientRoles)("rejects direct balance, ledger and paid writes for %s", async (role) => {
    const before = await snapshot();
    await asRole(role, ownId, async () => {
      await expect(db.query("UPDATE purama_ai.wallets SET balance = 999999 WHERE user_id = $1", [ownId]))
        .rejects.toThrow(/permission denied/);
      await expect(db.query(`INSERT INTO purama_ai.wallets (user_id, balance) VALUES ($1, 999999)`, [newId]))
        .rejects.toThrow(/permission denied/);
      await expect(db.query(`INSERT INTO purama_ai.wallet_transactions (user_id, amount, type, source)
        VALUES ($1, 999999, 'credit', 'forged')`, [ownId])).rejects.toThrow(/permission denied/);
      await expect(db.exec(`UPDATE ${commissions} SET status = 'paid', payment_date = now()`))
        .rejects.toThrow(/permission denied/);
      await expect(db.exec("TRUNCATE purama_ai.wallets")).rejects.toThrow(/permission denied/);
    });
    expect(await snapshot()).toEqual(before);
  });

  it("does not treat an authenticated application admin as the payment server", async () => {
    const before = await snapshot();
    await asRole("authenticated", adminId, async () => {
      await expect(db.exec(`UPDATE ${commissions} SET status = 'paid'`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`INSERT INTO ${commissions}
        (influencer_id, client_id, sale_amount, commission_amount, status)
        VALUES ($1, $2, 1, 1, 'paid')`, [influencerId, ownId])).rejects.toThrow(/permission denied/);
    });
    expect(await snapshot()).toEqual(before);
  });

  it("does not trust a client-set role claim as PostgreSQL service_role", async () => {
    await asRole("authenticated", ownId, async () => {
      await db.exec("SELECT set_config('request.jwt.claim.role', 'service_role', false)");
      try {
        await expect(db.exec("UPDATE purama_ai.wallets SET balance = 999999"))
          .rejects.toThrow(/permission denied/);
      } finally {
        await db.exec("SELECT set_config('request.jwt.claim.role', '', false)");
      }
    });
  });

  it.each([
    ["commission_rate", "99.99"], ["total_sales", "1000"], ["total_revenue", "100000"],
    ["commission_tier", "'gold'"], ["contract_status", "'signed'"],
    ["contract_signed_at", "now()"], ["expires_at", "now() + interval '100 years'"],
    ["user_id", `'${otherId}'`], ["promo_code", "'REPLACED'"],
  ])("refuses client UPDATE of influencer %s", async (column, value) => {
    const before = await snapshot();
    await asRole("authenticated", ownId, async () => {
      await expect(db.query(`UPDATE ${influencers} SET ${column} = ${value} WHERE id = $1`, [influencerId]))
        .rejects.toThrow(/permission denied/);
    });
    expect(await snapshot()).toEqual(before);
  });

  it("refuses privileged influencer fields during registration", async () => {
    await asRole("authenticated", newId, async () => {
      await expect(db.query(`INSERT INTO ${influencers}
        (user_id, promo_code, affiliation_link, commission_rate, contract_status)
        VALUES ($1, 'FORGED', 'https://example.test/', 99.99, 'signed')`, [newId]))
        .rejects.toThrow(/permission denied/);
    });
  });

  it("preserves the current registration payload and server-owned defaults", async () => {
    const defaults = (await db.query(`SELECT commission_rate, total_sales, total_revenue,
      commission_tier, contract_status FROM ${influencers} WHERE id = $1`, [influencerId])).rows;
    const created = await asRole("authenticated", newId, () => db.query(`INSERT INTO ${influencers}
      (user_id, promo_code, affiliation_link, beneficiary_name)
      VALUES ($1, 'NEW', 'https://example.test/?ref=NEW', 'New beneficiary')
      RETURNING commission_rate, total_sales, total_revenue, commission_tier, contract_status`, [newId]));
    expect(created.rows).toEqual(defaults);
  });

  it("preserves own profile and beneficiary coordinate updates", async () => {
    const updated = await asRole("authenticated", ownId, () => db.query(`UPDATE ${influencers}
      SET iban = 'TEST-UPDATED-IBAN', beneficiary_name = 'Updated beneficiary'
      WHERE id = $1 RETURNING iban, beneficiary_name`, [influencerId]));
    expect(updated.rows).toEqual([{ iban: "TEST-UPDATED-IBAN", beneficiary_name: "Updated beneficiary" }]);
    // The unrelated profile table is outside this migration and keeps its RLS.
    await db.exec("GRANT SELECT, UPDATE ON public.profiles TO authenticated");
    const profile = await asRole("authenticated", ownId, () => db.query(`UPDATE public.profiles
      SET full_name = 'Updated name' WHERE user_id = $1 RETURNING full_name`, [ownId]));
    expect(profile.rows).toEqual([{ full_name: "Updated name" }]);
  });

  it("preserves own reads and blocks cross-account reads and coordinate updates", async () => {
    await asRole("authenticated", ownId, async () => {
      for (const table of allTables) expect((await db.query(`SELECT * FROM ${table}`)).rows).toHaveLength(1);
      const result = await db.query(`UPDATE ${influencers} SET iban = 'FORGED'
        WHERE id = $1 RETURNING id`, [otherInfluencerId]);
      expect(result.rows).toEqual([]);
      await expect(db.query(`INSERT INTO ${influencers} (user_id, promo_code, affiliation_link)
        VALUES ($1, 'IMPERSONATION', 'https://example.test/')`, [newId]))
        .rejects.toThrow(/row-level security/);
    });
  });

  it("preserves authenticated admin reads without exposing rows to anonymous roles", async () => {
    for (const table of [influencers, commissions]) {
      const result = await asRole("authenticated", adminId, () => db.query(`SELECT * FROM ${table}`));
      expect(result.rows).toHaveLength(2);
    }
    for (const role of ["anon", "audit_public_only"] as const) {
      for (const table of allTables) {
        await asRole(role, null, async () => {
          await expect(db.query(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/);
        });
      }
    }
  });

  it("preserves withdrawal requests as pending with the current client payload", async () => {
    const result = await asRole("authenticated", ownId, () => db.query(`INSERT INTO purama_ai.withdrawals
      (user_id, amount, iban, beneficiary_name) VALUES ($1, 5, 'TEST-IBAN', 'Beneficiary')
      RETURNING user_id, amount::text, status, processed_at`, [ownId]));
    expect(result.rows).toEqual([{ user_id: ownId, amount: "5.00", status: "pending", processed_at: null }]);
  });

  it("rejects completed withdrawals, status changes, deletion and impersonation", async () => {
    const before = await snapshot();
    await asRole("authenticated", ownId, async () => {
      await expect(db.query(`INSERT INTO purama_ai.withdrawals
        (user_id, amount, iban, beneficiary_name, status)
        VALUES ($1, 99999, 'TEST-IBAN', 'Audit', 'completed')`, [ownId])).rejects.toThrow(/permission denied/);
      await expect(db.exec("UPDATE purama_ai.withdrawals SET status = 'completed', processed_at = now()"))
        .rejects.toThrow(/permission denied/);
      await expect(db.exec("DELETE FROM purama_ai.withdrawals")).rejects.toThrow(/permission denied/);
      await expect(db.query(`INSERT INTO purama_ai.withdrawals
        (user_id, amount, iban, beneficiary_name) VALUES ($1, 5, 'TEST-IBAN', 'Audit')`, [otherId]))
        .rejects.toThrow(/row-level security/);
    });
    expect(await snapshot()).toEqual(before);
  });

  it("preserves server writes with explicit grants and the actual BYPASSRLS role", async () => {
    const role = await db.query<{ bypass: boolean }>("SELECT rolbypassrls AS bypass FROM pg_roles WHERE rolname = 'service_role'");
    expect(role.rows).toEqual([{ bypass: true }]);
    await asRole("service_role", null, async () => {
      await db.query(`UPDATE ${influencers} SET commission_rate = 25, contract_status = 'signed'
        WHERE id = $1`, [influencerId]);
      await db.query("UPDATE purama_ai.wallets SET balance = balance + 10 WHERE user_id = $1", [ownId]);
      await db.query(`INSERT INTO purama_ai.wallet_transactions (user_id, amount, type, source)
        VALUES ($1, 10, 'credit', 'server-fixture')`, [ownId]);
      await db.exec(`UPDATE ${commissions} SET status = 'validated'`);
      await db.exec("UPDATE purama_ai.withdrawals SET status = 'processing'");
    });
    expect((await db.query("SELECT balance::text FROM purama_ai.wallets WHERE user_id = $1", [ownId])).rows)
      .toEqual([{ balance: "30.00" }]);
    expect((await db.query(`SELECT commission_rate::text, contract_status FROM ${influencers} WHERE id = $1`, [influencerId])).rows)
      .toEqual([{ commission_rate: "25.00", contract_status: "signed" }]);
    expect((await db.query("SELECT DISTINCT status FROM purama_ai.withdrawals")).rows)
      .toEqual([{ status: "processing" }]);
  });

  it("can be reapplied without granting financial fields or changing data", async () => {
    const before = await snapshot();
    await db.exec(hardening);
    await db.exec(hardening);
    expect(await snapshot()).toEqual(before);
    const access = await db.query(`SELECT
      has_column_privilege('authenticated', $1, 'commission_rate', 'UPDATE') AS client_rate,
      has_column_privilege('authenticated', $1, 'iban', 'UPDATE') AS client_iban,
      has_table_privilege('service_role', $1, 'UPDATE') AS server_write`, [influencers]);
    expect(access.rows).toEqual([{ client_rate: false, client_iban: true, server_write: true }]);
  });

  it("leaves the different public V4.1 wallet ledger unchanged", async () => {
    const current = (await db.query(`SELECT c.relacl::text,
      (SELECT jsonb_agg(jsonb_build_object('name', a.attname, 'type', a.atttypid)
        ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = c.oid
        AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
      (SELECT jsonb_agg(jsonb_build_object('name', p.polname, 'cmd', p.polcmd,
        'using', pg_get_expr(p.polqual, p.polrelid))) FROM pg_policy p
        WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c WHERE c.oid = 'public.wallet_transactions'::regclass`)).rows;
    expect(current).toEqual(publicLedgerDefinition);
  });

  it("rejects an unreviewed policy without partially changing other relations", async () => {
    await db.exec(`CREATE POLICY audit_unreviewed ON purama_ai.withdrawals
      FOR SELECT TO authenticated USING (true)`);
    const before = await snapshot();
    try {
      await expect(db.exec(hardening)).rejects.toThrow(/Unexpected commerce policies/);
    } finally {
      // PostgreSQL keeps the failed migration transaction aborted until rollback.
      await db.exec("ROLLBACK");
      await db.exec("DROP POLICY audit_unreviewed ON purama_ai.withdrawals");
    }
    expect(await snapshot()).toEqual(before);
    const access = await db.query(`SELECT
      has_column_privilege('authenticated', $1, 'commission_rate', 'UPDATE') AS client_rate,
      has_column_privilege('authenticated', $1, 'iban', 'UPDATE') AS client_iban`, [influencers]);
    expect(access.rows).toEqual([{ client_rate: false, client_iban: true }]);
  });
});
