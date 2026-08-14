// POST /functions/v1/contracts-ots-stamp
// Stamp a signed contract's PDF hash on Bitcoin blockchain via OpenTimestamps.
// Called by contracts-webhook when status → signed.
// Also callable manually (admin) for re-stamping.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.91.0";
import OpenTimestamps from "npm:opentimestamps@0.4.9";
import { CORS_HEADERS, corsResponse, errorResponse, docusealFetch, DOCUSEAL_URL, DOCUSEAL_TOKEN } from "../_shared/docuseal.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let body: { contract_id?: string };
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON"); }
  if (!body.contract_id) return errorResponse("Missing contract_id");

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return errorResponse("Missing Authorization", 401);

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { db: { schema: "purama_ai" } },
  );

  try {
    const { data: contract, error: loadErr } = await supabaseAdmin
      .from("contracts")
      .select("id, docuseal_submission_id, ots_stamp_hash, pdf_original_url")
      .eq("id", body.contract_id)
      .maybeSingle();
    if (loadErr || !contract) return errorResponse("Contract not found", 404);

    // Fetch signed PDF content (need raw bytes)
    let pdfBytes: Uint8Array;
    if (contract.docuseal_submission_id) {
      type DSDocs = { documents?: Array<{ url?: string }>; combined_document_url?: string };
      const docs = await docusealFetch<DSDocs>("GET", `/api/submissions/${contract.docuseal_submission_id}/documents`);
      const url = docs.combined_document_url ?? docs.documents?.[0]?.url;
      if (!url) return errorResponse("No signed PDF available", 404);
      const res = await fetch(url, {
        headers: url.startsWith(DOCUSEAL_URL) ? { "X-Auth-Token": DOCUSEAL_TOKEN } : {},
      });
      if (!res.ok) return errorResponse(`Failed to fetch PDF: ${res.status}`, 502);
      pdfBytes = new Uint8Array(await res.arrayBuffer());
    } else {
      return errorResponse("No submission linked", 400);
    }

    // SHA-256 hash
    const hashBuf = await crypto.subtle.digest("SHA-256", pdfBytes);
    const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");

    // Stamp via OpenTimestamps
    const detached = OpenTimestamps.DetachedTimestampFile.fromHash(
      new OpenTimestamps.Ops.OpSHA256(),
      new Uint8Array(hashBuf),
    );
    await OpenTimestamps.stamp(detached);
    const proofBytes = detached.serializeToBytes();
    const proofB64 = btoa(String.fromCharCode(...proofBytes));

    // Persist proof
    const { error: updErr } = await supabaseAdmin
      .from("contracts")
      .update({
        ots_stamp_hash: hashHex,
        ots_proof: proofB64,
      })
      .eq("id", body.contract_id);
    if (updErr) return errorResponse(`Update failed: ${updErr.message}`, 500);

    await supabaseAdmin.from("contract_events").insert({
      contract_id: body.contract_id,
      event_type: "ots_stamped",
      payload: { hash: hashHex, proof_size: proofBytes.length },
    });

    return corsResponse({ ok: true, hash: hashHex, pending_bitcoin_confirmation: true });
  } catch (err) {
    console.error("[ots-stamp] error:", err);
    return errorResponse(`Internal: ${(err as Error).message}`, 500);
  }
});
