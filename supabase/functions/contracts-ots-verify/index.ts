// GET /functions/v1/contracts-ots-verify?id=<uuid>
// Verify an OTS proof. If upgraded (confirmed in Bitcoin block), return block height + timestamp.
// Otherwise return pending=true.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import OpenTimestamps from "npm:opentimestamps@0.4.9";
import { CORS_HEADERS, corsResponse, errorResponse, docusealFetch, DOCUSEAL_URL, DOCUSEAL_TOKEN } from "../_shared/docuseal.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "GET") return errorResponse("Method not allowed", 405);

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return errorResponse("Missing Authorization", 401);

  const url = new URL(req.url);
  const contractId = url.searchParams.get("id");
  if (!contractId) return errorResponse("Missing ?id=<uuid>");

  const upgrade = url.searchParams.get("upgrade") === "true";

  const supabase = createClient(
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
    const { data: contract, error: loadErr } = await supabase
      .from("contracts")
      .select("id, ots_stamp_hash, ots_proof, ots_verified_at, ots_block_height, ots_btc_timestamp, docuseal_submission_id")
      .eq("id", contractId)
      .maybeSingle();
    if (loadErr) return errorResponse(loadErr.message, 500);
    if (!contract) return errorResponse("Contract not found or unauthorized", 404);
    if (!contract.ots_proof || !contract.ots_stamp_hash) {
      return errorResponse("No OTS proof on this contract", 404);
    }

    // Decode proof
    const proofBytes = Uint8Array.from(atob(contract.ots_proof), c => c.charCodeAt(0));
    const detachedProof = OpenTimestamps.DetachedTimestampFile.deserialize(proofBytes);

    // Reconstruct original from hash
    const hashBytes = new Uint8Array(
      contract.ots_stamp_hash.match(/.{2}/g)!.map((h: string) => parseInt(h, 16))
    );
    const detachedOriginal = OpenTimestamps.DetachedTimestampFile.fromHash(
      new OpenTimestamps.Ops.OpSHA256(),
      hashBytes,
    );

    // Try upgrade (fetch Bitcoin confirmation if available)
    if (upgrade) {
      try { await OpenTimestamps.upgrade(detachedProof); } catch { /* may be pending */ }
    }

    const result = await OpenTimestamps.verify(detachedProof, detachedOriginal);

    if (result?.bitcoin) {
      const blockHeight = result.bitcoin.height;
      const btcTimestamp = new Date(result.bitcoin.timestamp * 1000).toISOString();

      // Persist if not already
      if (!contract.ots_block_height || contract.ots_block_height !== blockHeight) {
        await supabaseAdmin.from("contracts").update({
          ots_verified_at: new Date().toISOString(),
          ots_block_height: blockHeight,
          ots_btc_timestamp: btcTimestamp,
          ots_proof: btoa(String.fromCharCode(...detachedProof.serializeToBytes())),
        }).eq("id", contractId);

        await supabaseAdmin.from("contract_events").insert({
          contract_id: contractId,
          event_type: "ots_verified",
          payload: { block_height: blockHeight, btc_timestamp: btcTimestamp },
        });
      }

      return corsResponse({
        verified: true,
        block_height: blockHeight,
        btc_timestamp: btcTimestamp,
        blockstream_url: `https://blockstream.info/block-height/${blockHeight}`,
      });
    }

    return corsResponse({
      verified: false,
      pending: true,
      message: "Bitcoin confirmation pending — try again in 1-6 hours",
    });
  } catch (err) {
    console.error("[ots-verify] error:", err);
    return errorResponse(`Internal: ${(err as Error).message}`, 500);
  }
});
