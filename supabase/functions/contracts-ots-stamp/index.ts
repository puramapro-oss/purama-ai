// Signed webhook service or authenticated administrator only.
import { CORS_HEADERS, corsResponse, errorResponse } from "../_shared/docuseal.ts";
import { authorizeOts, otsAdminClient, OtsHttpError, validContractId } from "../_shared/ots-auth.ts";
import { signedPdf, SIGNED_DOCUMENT_TIMEOUT_MS } from "../_shared/ots-pdf.ts";
import { createRequestDeadline } from "../../../src/lib/request-deadline.ts";
import { ots } from "../_shared/ots-library.ts";
import { loadOtsContract, requireUnchangedContract, conditionOnSnapshot, readOtsBody } from "../_shared/ots-contract.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);
  let documentDeadline: ReturnType<typeof createRequestDeadline> | undefined;
  try {
    const initialAccess = await authorizeOts(req, true);
    const body = await readOtsBody(req);
    if (!validContractId(body.contract_id)) throw new OtsHttpError(400, "Invalid contract_id");
    const contract = await loadOtsContract(initialAccess.client, body.contract_id);
    if (contract.status !== "signed") throw new OtsHttpError(409, "Contract must be signed");
    // Preserve one document window through reauthorization and hashing, up to
    // the first stamp, not for subsequent stamping and persistence operations.
    documentDeadline = createRequestDeadline(SIGNED_DOCUMENT_TIMEOUT_MS, req.signal);
    const pdf = await signedPdf(contract.docuseal_submission_id, req.signal, documentDeadline);
    const beforeStamp = await authorizeOts(req, true);
    requireUnchangedContract(contract, await loadOtsContract(beforeStamp.client, contract.id));
    if (req.signal.aborted) throw new OtsHttpError(408, "Request cancelled");
    documentDeadline.check();
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", pdf));
    if (req.signal.aborted) throw new OtsHttpError(408, "Request cancelled");
    const hashHex = Array.from(hash).map(byte => byte.toString(16).padStart(2, "0")).join("");
    documentDeadline.check();
    const proof = await ots.stampDigest(hash);
    const finalAccess = await authorizeOts(req, true);
    requireUnchangedContract(contract, await loadOtsContract(finalAccess.client, contract.id));
    // Human writes retain RLS; the exact service credential is the only bypass.
    const update = finalAccess.client.from("contracts").update({ ots_stamp_hash: hashHex, ots_proof: proof,
      ots_verified_at: null, ots_block_height: null, ots_btc_timestamp: null });
    const { data: written, error } = await conditionOnSnapshot(update, contract).select("id").maybeSingle();
    if (error) throw new OtsHttpError(500, "Proof persistence failed");
    if (!written) throw new OtsHttpError(409, "Contract changed; retry verification");
    const { error: eventError } = await otsAdminClient().from("contract_events").insert({ contract_id: contract.id, event_type: "ots_stamped",
      payload: { hash: hashHex, proof_size: atob(proof).length }, actor_id: finalAccess.userId, actor_type: finalAccess.service ? "service" : "user" });
    if (eventError) throw new OtsHttpError(500, "Proof audit event persistence failed");
    return corsResponse({ ok: true, hash: hashHex, pending_bitcoin_confirmation: true });
  } catch (error) {
    if (error instanceof OtsHttpError) return errorResponse(error.message, error.status);
    return errorResponse("Proof stamping unavailable", 502);
  } finally { documentDeadline?.close(); }
});
