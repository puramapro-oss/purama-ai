import { supabase } from "../db/supabase.js";
import type { ToolDefinition } from "../engine/types.js";

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

export const supabaseUpsertTool: ToolDefinition<{ table: string; row: Record<string, unknown> }, { id?: string }> = {
  name: "supabase_upsert",
  description: "Insère ou met à jour une ligne dans une table métier autorisée (transactions, factures, documents, prospects...).",
  sensitive: false,
  async execute(params, ctx) {
    assertAllowedTable(params.table);
    if (!params.row || typeof params.row !== "object" || Array.isArray(params.row)) throw new Error("Ligne invalide");
    const row: Record<string, unknown> = { ...params.row, user_id: ctx.userId };
    if (row.id !== undefined) {
      if (typeof row.id !== "string" || !row.id) throw new Error("Identifiant invalide");
      // The ownership predicate is part of the UPDATE itself. Never follow a
      // separate ownership read with an unrestricted service-role upsert.
      const updated = await supabase.from(params.table).update(row)
        .eq("id", row.id).eq("user_id", ctx.userId).select("id").maybeSingle();
      if (updated.error) throw new Error(`supabase_upsert(${params.table}): écriture refusée`);
      if (updated.data) return { id: updated.data.id };
    }
    // A foreign/existing primary key fails the INSERT; it cannot be reassigned.
    const { data, error } = await supabase.from(params.table).insert(row).select("id").single();
    if (error) throw new Error(`supabase_upsert(${params.table}): insertion refusée`);
    if (!data?.id) throw new Error("Écriture sans preuve de résultat");
    return { id: data.id };
  },
};

export const supabaseSelectTool: ToolDefinition<{ table: string; filters?: Record<string, unknown>; limit?: number }, unknown[]> = {
  name: "supabase_select",
  description: "Lit des lignes dans une table métier autorisée pour construire le contexte de décision.",
  sensitive: false,
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
};
