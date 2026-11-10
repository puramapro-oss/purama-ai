// POST /functions/v1/contracts-ots-stamp
// Stamp a signed contract's PDF hash on Bitcoin blockchain via OpenTimestamps.
// Called by contracts-webhook when status → signed.
// Also callable manually (admin) for re-stamping.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.91.0";
import OpenTimestamps from "npm:opentimestamps@0.4.9";
import { CORS_HEADERS, corsResponse, errorResponse } from "../_shared/docuseal.ts";
import { verifyBearerSecret } from "../_shared/webhook-security.ts";
import { readOtsBody, OtsHttpError } from "../_shared/ots-body.ts";
import { fetchSignedPdf, OtsDocumentError } from "../_shared/ots-document.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  const authHeader = req.headers.get("authorization");
  const bearer = authHeader?.match(/^Bearer ([^\s]+)$/);
  if (!bearer) return errorResponse("Missing or invalid Authorization", 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) return errorResponse("Stamping unavailable", 503);

  try {
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      db: { schema: "purama_ai" },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // The gateway's JWT check does not grant administrative contract rights.
    // Accept the exact internal credential, or verify a user and their current
    // server-owned role before reading contract data or invoking providers.
    const isService = verifyBearerSecret(authHeader, serviceRoleKey);
    let actorId: string | null = null;
    if (!isService) {
      try {
        const { data: auth, error: authError } = await supabaseAdmin.auth.getUser(bearer[1]);
        if (authError || !auth?.user) return errorResponse("Unauthenticated", 401);
        // Preserve PR #33's server-side role function, also used by contract RLS.
        // Only an actual boolean true authorizes the authenticated identity.
        const { data: isAdmin, error: roleError } = await supabaseAdmin.schema("public").rpc("has_role", {
          _user_id: auth.user.id, _role: "admin",
        });
        if (roleError) return errorResponse("Authorization unavailable", 503);
        if (isAdmin !== true) return errorResponse("Admin access required", 403);
        actorId = auth.user.id;
      } catch {
        return errorResponse("Authorization unavailable", 503);
      }
    }

    let body: unknown;
    try {
      body = await readOtsBody(req);
    } catch (error) {
      return error instanceof OtsHttpError
        ? errorResponse(error.message, error.status)
        : errorResponse("Invalid JSON");
    }
    const contractId = body && typeof body === "object" && !Array.isArray(body)
      ? (body as { contract_id?: unknown }).contract_id : undefined;
    if (typeof contractId !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(contractId)) {
      return errorResponse("Invalid contract_id");
    }

    const { data: contract, error: loadErr } = await supabaseAdmin
      .from("contracts")
      .select("id, status, docuseal_submission_id, ots_stamp_hash, pdf_original_url")
      .eq("id", contractId)
      .maybeSingle();
    if (loadErr) return errorResponse("Contract lookup failed", 500);
    if (!contract) return errorResponse("Contract not found", 404);
    if (contract.status !== "signed") return errorResponse("Contract is not signed", 409);

    // Metadata and raw PDF bytes share one deadline and fixed byte budgets.
    const submissionId = contract.docuseal_submission_id;
    if (!submissionId || (typeof submissionId !== "string" && typeof submissionId !== "number")) {
      return errorResponse("No submission linked", 400);
    }
    const pdf = await fetchSignedPdf(submissionId, req.signal);

    // SHA-256 hash
    pdf.assertCurrent();
    const hashBuf = await crypto.subtle.digest("SHA-256", pdf.bytes);
    pdf.assertCurrent();
    const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");

    // Stamp via OpenTimestamps
    const detached = OpenTimestamps.DetachedTimestampFile.fromHash(
      new OpenTimestamps.Ops.OpSHA256(),
      new Uint8Array(hashBuf),
    );
    await OpenTimestamps.stamp(detached);
    // opentimestamps 0.4.9 resolves even when every calendar request failed.
    // A hash/operation tree without any attestation is not a pending receipt.
    if (detached.timestamp.allAttestations().size === 0) {
      return errorResponse("No timestamp calendar accepted the request", 502);
    }
    const proofBytes = detached.serializeToBytes();
    const proofB64 = btoa(String.fromCharCode(...proofBytes));

    // Persist proof
    const { data: updated, error: updErr } = await supabaseAdmin
      .from("contracts")
      .update({
        ots_stamp_hash: hashHex,
        ots_proof: proofB64,
        ots_verified_at: null,
        ots_block_height: null,
        ots_btc_timestamp: null,
      })
      .eq("id", contractId)
      .eq("status", "signed")
      .eq("docuseal_submission_id", contract.docuseal_submission_id)
      .select("id")
      .maybeSingle();
    if (updErr) return errorResponse("Proof update failed", 500);
    if (!updated) return errorResponse("Contract changed during stamping", 409);

    const { error: eventError } = await supabaseAdmin.from("contract_events").insert({
      contract_id: contractId,
      event_type: "ots_stamped",
      actor_id: actorId,
      actor_type: isService ? "service" : "user",
      payload: { hash: hashHex, proof_size: proofBytes.length },
    });
    if (eventError) return errorResponse("Stamp audit record failed", 500);

    return corsResponse({ ok: true, hash: hashHex, pending_bitcoin_confirmation: true });
  } catch (error) {
    if (error instanceof OtsDocumentError) return errorResponse(error.message, error.status);
    // Provider errors may contain private URLs or response bodies.
    console.error("[ots-stamp] operation failed");
    return errorResponse("Stamping failed", 500);
  }
});
