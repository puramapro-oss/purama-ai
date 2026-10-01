import { supabase } from "../db/supabase.js";
import type { ToolDefinition } from "../engine/types.js";
import { defineTool, enumSchema, integerSchema, jsonRecordSchema, objectSchema, optionalSchema, ToolInputError } from "./validation.js";

/** Tables purama_ai autorisées pour l'outil générique upsert/select — liste blanche explicite,
 * jamais de nom de table dynamique arbitraire venant de Claude. */
const ALLOWED_TABLES = [
  "compta_transactions",
  "compta_invoices",
  "legal_documents",
  "legal_cases",
  "legal_impayes",
  "partner_prospects",
  "partner_emails",
  "email_agent_logs",
  "karta_crm_leads",
] as const;

type AllowedTable = (typeof ALLOWED_TABLES)[number];

function assertAllowedTable(table: string): asserts table is AllowedTable {
  if (!ALLOWED_TABLES.includes(table as AllowedTable)) {
    throw new Error(`Table "${table}" non autorisée pour supabase_upsert/supabase_select (liste blanche)`);
  }
}

export const supabaseUpsertTool: ToolDefinition<{ table: string; row: Record<string, unknown> }, { id?: string }> = defineTool({
  name: "supabase_upsert",
  description: "Insère une nouvelle ligne sans id, ou met à jour une ligne existante par id appartenant à l'utilisateur, dans une table métier autorisée.",
  sensitive: false,
  input: objectSchema({ table: enumSchema(ALLOWED_TABLES), row: jsonRecordSchema() }, ({ row }) => {
    if (Object.hasOwn(row, "id") && (typeof row.id !== "string" || row.id.trim().length === 0 || row.id.length > 200)) {
      throw new ToolInputError("input.row.id", "identifiant texte non vide attendu");
    }
  }),
  async execute(params, ctx) {
    assertAllowedTable(params.table);
    const { id, ...fields } = params.row;
    const row = { ...fields, user_id: ctx.userId };
    // The owner predicate is part of the UPDATE itself, not a racy preliminary read.
    // INSERT never falls back to an unscoped upsert on a conflicting primary key.
    const query = typeof id === "string"
      ? supabase.from(params.table).update(row).eq("id", id).eq("user_id", ctx.userId)
      : supabase.from(params.table).insert(row);
    const { data, error } = await query.select("id").maybeSingle();

    if (error) throw new Error(`supabase_upsert(${params.table}): ${error.message}`);
    if (!data?.id) throw new Error("supabase_upsert: aucune ligne autorisée confirmée");
    return { id: data.id };
  },
});

export const supabaseSelectTool: ToolDefinition<{ table: string; filters?: Record<string, unknown>; limit?: number }, unknown[]> = defineTool({
  name: "supabase_select",
  description: "Lit des lignes dans une table métier autorisée pour construire le contexte de décision.",
  sensitive: false,
  input: objectSchema({
    table: enumSchema(ALLOWED_TABLES),
    filters: optionalSchema(jsonRecordSchema(true)),
    limit: optionalSchema(integerSchema(1, 100)),
  }),
  async execute(params, ctx) {
    assertAllowedTable(params.table);
    let query = supabase
      .from(params.table)
      .select("*")
      .eq("user_id", ctx.userId)
      .limit(params.limit ?? 20);

    for (const [key, value] of Object.entries(params.filters ?? {})) {
      query = query.eq(key, value as string | number | boolean);
    }

    const { data, error } = await query;
    if (error) throw new Error(`supabase_select(${params.table}): ${error.message}`);
    return data ?? [];
  },
});
