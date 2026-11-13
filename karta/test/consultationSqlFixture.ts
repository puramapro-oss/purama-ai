import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { CHEF_RECONCILIATION_MIGRATIONS } from "./migration-fixtures.js";
import type { ConsultationRpcClient } from "../src/claude/consultation-store.js";

/** Real PostgreSQL/WASM and production migrations. One backend serializes
 * concurrent queries; this is not a native multi-connection lock test. */
export async function createConsultationSqlFixture(userIds: string[] = []) {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      CREATE SCHEMA purama_ai; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      GRANT USAGE ON SCHEMA auth,purama_ai TO service_role,authenticated,anon;`);
    for (const file of [...CHEF_RECONCILIATION_MIGRATIONS, "031_model_consultation.sql"]) {
      await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
    for (const userId of userIds) await db.query("INSERT INTO auth.users(id) VALUES($1)", [userId]);
    await db.exec("SET ROLE service_role");
    const client: ConsultationRpcClient = {
      rpc(name, args) {
        if (!/^model_consultation_[a-z_]+$/.test(name) || Object.keys(args).some(key => !/^p_[a-z_]+$/.test(key))) {
          throw new Error("Unexpected test RPC");
        }
        return { async abortSignal(signal) {
          signal.throwIfAborted();
          try {
            const values = Object.values(args).map(value => value !== null && typeof value === "object" ? JSON.stringify(value) : value);
            const named = Object.keys(args).map((key, index) => `${key}=>$${index + 1}`).join(",");
            const result = await db.query<{ data: unknown }>(`SELECT purama_ai.${name}(${named}) AS data`, values);
            return { data: result.rows[0].data, error: null };
          } catch (error) {
            return { data: null, error: { code: String((error as { code?: string }).code ?? "unknown") } };
          }
        } };
      },
    };
    return { db, client, close: () => db.close() };
  } catch (error) { await db.close(); throw error; }
}
