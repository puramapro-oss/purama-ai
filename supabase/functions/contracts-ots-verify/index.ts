import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { CORS_HEADERS, corsResponse, errorResponse } from "../_shared/docuseal.ts";
import { authorizeOts, otsAdminClient, OtsHttpError, validContractId } from "../_shared/ots-auth.ts";
import { loadOtsContract, requireUnchangedContract, conditionOnSnapshot } from "../_shared/ots-contract.ts";
import { ots } from "../_shared/ots-library.ts";
import { proofFromBase64, OtsError } from "../../../src/lib/ots-core.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "GET") return errorResponse("Method not allowed", 405);
  try {
    const initialAccess = await authorizeOts(req);
    const url = new URL(req.url); const id = url.searchParams.get("id");
    if (!validContractId(id)) throw new OtsHttpError(400, "Invalid contract identifier");
    const contract = await loadOtsContract(initialAccess.client, id);
    if (!contract.ots_proof || !contract.ots_stamp_hash) throw new OtsHttpError(404, "No OTS proof on this contract");
    if (!/^[a-f0-9]{64}$/i.test(contract.ots_stamp_hash)) throw new OtsHttpError(409, "Stored proof is invalid");
    try { proofFromBase64(contract.ots_proof); } catch { throw new OtsHttpError(409, "Stored proof is invalid"); }
    const hash = Uint8Array.from(contract.ots_stamp_hash.match(/.{2}/g)!, value => parseInt(value, 16));
    const result = await ots.verifyDigest(hash, contract.ots_proof, url.searchParams.get("upgrade") === "true");
    const finalAccess = await authorizeOts(req);
    requireUnchangedContract(contract, await loadOtsContract(finalAccess.client, id));
    if (!result.bitcoin) return corsResponse({ verified: false, pending: true, message: "Bitcoin confirmation pending" });
    const { height, timestamp } = result.bitcoin;
    const btcTimestamp = new Date(timestamp * 1000).toISOString();
    if (!contract.ots_verified_at || contract.ots_block_height !== height || contract.ots_proof !== result.proof) {
      const update = otsAdminClient().from("contracts").update({ ots_verified_at: new Date().toISOString(), ots_block_height: height,
        ots_btc_timestamp: btcTimestamp, ots_proof: result.proof });
      const { data: written, error } = await conditionOnSnapshot(update, contract).select("id").maybeSingle();
      if (error) throw new OtsHttpError(500, "Proof persistence failed");
      if (!written) throw new OtsHttpError(409, "Contract changed; retry verification");
      const { error: eventError } = await otsAdminClient().from("contract_events").insert({ contract_id: id, event_type: "ots_verified",
        payload: { block_height: height, btc_timestamp: btcTimestamp }, actor_id: finalAccess.userId, actor_type: finalAccess.service ? "system" : "user" });
      if (eventError) throw new OtsHttpError(500, "Proof audit event persistence failed");
    }
    return corsResponse({ verified: true, block_height: height, btc_timestamp: btcTimestamp, blockstream_url: `https://blockstream.info/block-height/${height}` });
  } catch (error) {
    if (error instanceof OtsHttpError) return errorResponse(error.message, error.status);
    if (error instanceof OtsError && /INVALID_PROOF|HASH_MISMATCH|PROOF_TOO_COMPLEX/.test(error.code)) return errorResponse("Stored proof is invalid", 409);
    return errorResponse("Proof verification unavailable", 502);
  }
});
