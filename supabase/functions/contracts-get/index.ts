// GET /functions/v1/contracts-get?id=<uuid>
// Fetch a single contract with signers + events. RLS enforces access.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { CORS_HEADERS, corsResponse, errorResponse } from "../_shared/docuseal.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "GET") return errorResponse("Method not allowed", 405);

  const url = new URL(req.url);
  const contractId = url.searchParams.get("id");
  if (!contractId) return errorResponse("Missing ?id=<uuid>");

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return errorResponse("Missing Authorization", 401);

  // Use USER client so RLS applies (users see own, admins see all)
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    {
      db: { schema: "purama_ai" },
      global: { headers: { Authorization: authHeader } },
    },
  );

  try {
    const { data: contract, error: cErr } = await supabase
      .from("contracts")
      .select("*")
      .eq("id", contractId)
      .maybeSingle();
    if (cErr) return errorResponse(cErr.message, 500);
    if (!contract) return errorResponse("Contract not found or unauthorized", 404);

    const { data: signers } = await supabase
      .from("contract_signers")
      .select("id, email, name, role, order_index, signed, signed_at, opened_at, declined_at")
      .eq("contract_id", contractId)
      .order("order_index", { ascending: true });

    const { data: events } = await supabase
      .from("contract_events")
      .select("id, event_type, payload, created_at")
      .eq("contract_id", contractId)
      .order("created_at", { ascending: false })
      .limit(50);

    return corsResponse({ contract, signers: signers ?? [], events: events ?? [] });
  } catch (err) {
    return errorResponse(`Internal error: ${(err as Error).message}`, 500);
  }
});
