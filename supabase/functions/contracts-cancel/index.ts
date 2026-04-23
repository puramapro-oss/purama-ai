// POST /functions/v1/contracts-cancel
// Cancel a contract: archive DocuSeal submission + update status.
// Auth: user (own contracts) or admin.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { CORS_HEADERS, corsResponse, errorResponse, docusealFetch } from "../_shared/docuseal.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return errorResponse("Missing Authorization", 401);

  let body: { contract_id?: string; reason?: string };
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON"); }
  if (!body.contract_id) return errorResponse("Missing contract_id");

  const supabaseUser = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    {
      db: { schema: "purama_ai" },
      global: { headers: { Authorization: authHeader } },
    },
  );

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { db: { schema: "purama_ai" } },
  );

  try {
    // Load contract (RLS check: user must own it OR be admin)
    const { data: contract, error: loadErr } = await supabaseUser
      .from("contracts")
      .select("id, status, docuseal_submission_id, user_id")
      .eq("id", body.contract_id)
      .maybeSingle();
    if (loadErr) return errorResponse(loadErr.message, 500);
    if (!contract) return errorResponse("Contract not found or unauthorized", 404);
    if (contract.status === "signed") return errorResponse("Cannot cancel already signed contract", 400);
    if (contract.status === "cancelled") return errorResponse("Contract already cancelled", 409);

    // Archive DocuSeal submission
    if (contract.docuseal_submission_id) {
      try {
        await docusealFetch("DELETE", `/api/submissions/${contract.docuseal_submission_id}`);
      } catch (e) {
        console.warn(`[cancel] DocuSeal archive warning: ${(e as Error).message}`);
      }
    }

    // Update contract (admin client for the write — RLS could block user write)
    const { error: updateErr } = await supabaseAdmin
      .from("contracts")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
      })
      .eq("id", body.contract_id);
    if (updateErr) return errorResponse(updateErr.message, 500);

    // Get the authenticated user for the audit trail
    const { data: { user } } = await supabaseUser.auth.getUser();
    await supabaseAdmin.from("contract_events").insert({
      contract_id: body.contract_id,
      event_type: "cancelled",
      payload: { reason: body.reason ?? "user_cancel" },
      actor_id: user?.id ?? null,
      actor_type: "user",
    });

    return corsResponse({ ok: true, contract_id: body.contract_id, status: "cancelled" });
  } catch (err) {
    return errorResponse(`Internal error: ${(err as Error).message}`, 500);
  }
});
