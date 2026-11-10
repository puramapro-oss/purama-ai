// Signed webhook service or authenticated administrator only.
import { CORS_HEADERS, corsResponse, errorResponse } from "../_shared/docuseal.ts";
import { authorizeOts, OtsHttpError, validContractId } from "../_shared/ots-auth.ts";
import { fetchSignedPdf, OtsDocumentError } from "../_shared/ots-document.ts";
import { ots } from "../_shared/ots-library.ts";
import { loadOtsContract, requireUnchangedContract, readOtsBody } from "../_shared/ots-contract.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);
  try {
    const initialAccess = await authorizeOts(req, true);
    const body = await readOtsBody(req);
    if (!validContractId(body.contract_id)) throw new OtsHttpError(400, "Invalid contract_id");
    const contract = await loadOtsContract(initialAccess.client, body.contract_id);
    if (contract.status !== "signed") throw new OtsHttpError(409, "Contract must be signed");
    const pdf = await fetchSignedPdf(contract.docuseal_submission_id, req.signal);
    const beforeStamp = await authorizeOts(req, true);
    requireUnchangedContract(contract, await loadOtsContract(beforeStamp.client, contract.id));
    pdf.assertCurrent();
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", pdf.bytes));
    pdf.assertCurrent();
    const hashHex = Array.from(hash).map(byte => byte.toString(16).padStart(2, "0")).join("");
    const proof = await ots.stampDigest(hash);
    const finalAccess = await authorizeOts(req, true);
    requireUnchangedContract(contract, await loadOtsContract(finalAccess.client, contract.id));
    // One database transaction persists both proof and audit. This invoker RPC
    // keeps the final human JWT/RLS and the complete original contract snapshot.
    const { data: written, error } = await finalAccess.client.rpc("persist_contract_ots_stamp", {
      p_contract_id: contract.id, p_user_id: contract.user_id,
      p_submission_id: contract.docuseal_submission_id,
      p_previous_hash: contract.ots_stamp_hash, p_previous_proof: contract.ots_proof,
      p_hash: hashHex, p_proof: proof,
    });
    if (error) throw new OtsHttpError(500, "Proof persistence failed");
    if (!written) throw new OtsHttpError(409, "Contract changed; retry verification");
    return corsResponse({ ok: true, hash: hashHex, pending_bitcoin_confirmation: true });
  } catch (error) {
    if (error instanceof OtsHttpError || error instanceof OtsDocumentError) return errorResponse(error.message, error.status);
    return errorResponse("Proof stamping unavailable", 502);
  }
});
