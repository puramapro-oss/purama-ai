import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const historical = readFileSync(new URL(
  "../../supabase/migrations/20260422180100_v4_1_helpers_rpc.sql", import.meta.url,
), "utf8");
const hardening = readFileSync(new URL(
  "../../supabase/migrations/20261108200100_wallet_rpc_service_only.sql", import.meta.url,
), "utf8");
const userId = "00000000-0000-4000-8000-000000000001";
const clientRoles = ["anon", "authenticated", "audit_other"] as const;
type Role = typeof clientRoles[number] | "service_role";
const functions = [
  {
    name: "increment_wallet_balance",
    signature: "public.increment_wallet_balance(uuid,numeric)",
    call: "SELECT public.increment_wallet_balance($1, 25)",
  },
  {
    name: "prime_mark_payment",
    signature: "public.prime_mark_payment(uuid,text)",
    call: "SELECT public.prime_mark_payment($1, 'purama-ai')",
  },
  {
    name: "prime_suspend_payment",
    signature: "public.prime_suspend_payment(uuid,text)",
    call: "SELECT public.prime_suspend_payment($1, 'purama-ai')",
  },
] as const;

let db: PGlite;
let originalDefinitions: unknown[];
let historicalClientGrants: boolean[];

async function asRole<T>(role: Role, work: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try { return await work(); }
  finally { await db.exec("RESET ROLE"); }
}

async function definitions(): Promise<unknown[]> {
  return (await db.query(`
    SELECT oid::text, proowner::text, prosecdef, proconfig, pg_get_functiondef(oid) AS definition
    FROM pg_proc
    WHERE oid IN (
      'public.increment_wallet_balance(uuid,numeric)'::regprocedure,
      'public.prime_mark_payment(uuid,text)'::regprocedure,
      'public.prime_suspend_payment(uuid,text)'::regprocedure
    ) ORDER BY oid
  `)).rows;
}

async function snapshot(): Promise<unknown[]> {
  return (await db.query(`
    SELECT p.wallet_balance::text, r.palier_actuel,
      r.subscription_payment_check_1, r.subscription_payment_check_2,
      r.subscription_payment_check_3
    FROM public.profiles p JOIN public.primes r ON r.user_id = p.id
  `)).rows;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE audit_other;
    CREATE ROLE service_role;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, audit_other, service_role;
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, wallet_balance numeric NOT NULL DEFAULT 0);
    CREATE TABLE public.primes (
      user_id uuid NOT NULL, app_id text NOT NULL, palier_actuel integer NOT NULL DEFAULT 0,
      subscription_payment_check_1 boolean NOT NULL DEFAULT false,
      subscription_payment_check_2 boolean NOT NULL DEFAULT false,
      subscription_payment_check_3 boolean NOT NULL DEFAULT false,
      PRIMARY KEY (user_id, app_id)
    );
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.primes ENABLE ROW LEVEL SECURITY;
    CREATE FUNCTION public.audit_unrelated() RETURNS integer LANGUAGE sql AS $$ SELECT 7 $$;
  `);
  // Execute the real historical migration, then model explicit client grants too.
  // This checks both the implicit PUBLIC path and direct anon/authenticated ACLs.
  await db.exec(historical);
  for (const fn of functions) {
    await db.exec(`GRANT EXECUTE ON FUNCTION ${fn.signature} TO anon, authenticated`);
  }
  historicalClientGrants = [];
  for (const role of clientRoles) {
    for (const fn of functions) {
      const result = await db.query<{ allowed: boolean }>(
        "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed", [role, fn.signature],
      );
      historicalClientGrants.push(result.rows[0].allowed);
    }
  }
  originalDefinitions = await definitions();
  await db.exec(hardening);
});

beforeEach(async () => {
  await db.exec("TRUNCATE public.profiles, public.primes");
  await db.query("INSERT INTO public.profiles (id, wallet_balance) VALUES ($1, 10)", [userId]);
  await db.query("INSERT INTO public.primes (user_id, app_id) VALUES ($1, 'purama-ai')", [userId]);
});

afterAll(async () => { await db?.close(); });

it("starts from the historical PUBLIC and explicit client grants", () => {
  expect(historicalClientGrants).toEqual(Array(9).fill(true));
});

describe.each(clientRoles)("payment helpers called by %s", (role) => {
  it.each(functions)("denies $name at the function boundary without changing data", async (fn) => {
    const before = await snapshot();
    const privilege = await db.query<{ allowed: boolean }>(
      "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed", [role, fn.signature],
    );
    expect(privilege.rows[0].allowed).toBe(false);
    await asRole(role, async () => {
      await expect(db.query(fn.call, [userId])).rejects.toThrow(/permission denied for function/);
    });
    expect(await snapshot()).toEqual(before);
  });
});

it("also denies the default app_id invocation", async () => {
  await asRole("authenticated", async () => {
    await expect(db.query("SELECT public.prime_mark_payment($1)", [userId]))
      .rejects.toThrow(/permission denied for function/);
    await expect(db.query("SELECT public.prime_suspend_payment($1)", [userId]))
      .rejects.toThrow(/permission denied for function/);
  });
});

it("preserves a server wallet increment", async () => {
  await asRole("service_role", () => db.query(functions[0].call, [userId]));
  expect((await db.query("SELECT wallet_balance::text AS amount FROM public.profiles")).rows)
    .toEqual([{ amount: "35" }]);
});

it("preserves server payment tracking", async () => {
  const result = await asRole("service_role", () => db.query(functions[1].call, [userId]));
  expect(result.rows).toEqual([{ prime_mark_payment: 1 }]);
  expect((await db.query("SELECT subscription_payment_check_1 AS paid FROM public.primes")).rows)
    .toEqual([{ paid: true }]);
});

it("preserves server payment suspension", async () => {
  await db.exec(`UPDATE public.primes SET
    subscription_payment_check_1 = true,
    subscription_payment_check_2 = true,
    subscription_payment_check_3 = true`);
  await asRole("service_role", () => db.query(functions[2].call, [userId]));
  expect((await db.query(`SELECT subscription_payment_check_1 AS first,
    subscription_payment_check_2 AS second, subscription_payment_check_3 AS third
    FROM public.primes`)).rows).toEqual([{ first: false, second: false, third: false }]);
});

it("can be reapplied without reopening clients or dropping server access", async () => {
  await db.exec(hardening);
  await db.exec(hardening);
  for (const role of [...clientRoles, "service_role"] as const) {
    for (const fn of functions) {
      const result = await db.query<{ allowed: boolean }>(
        "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed", [role, fn.signature],
      );
      expect(result.rows[0].allowed).toBe(role === "service_role");
    }
  }
});

it("preserves function identity, owner, body and configuration", async () => {
  expect(await definitions()).toEqual(originalDefinitions);
});

it("leaves unrelated public functions callable", async () => {
  for (const role of clientRoles) {
    const result = await asRole(role, () => db.query("SELECT public.audit_unrelated() AS value"));
    expect(result.rows).toEqual([{ value: 7 }]);
  }
});
