// POST /functions/v1/contracts-webhook
// Receives DocuSeal webhooks on submission lifecycle events.
// Authenticates Bearer or exact-body HMAC, updates contracts and acknowledges OTS delivery.

import { createClient } from "npm:@supabase/supabase-js@2.91.0";
import {
  CORS_HEADERS, corsResponse, errorResponse,
  DOCUSEAL_WEBHOOK_SECRET, docusealFetch,
} from "../_shared/docuseal.ts";
import { hasHmacSignatureFormat, verifyBearerSecret, verifyDocusealWebhook } from "../_shared/webhook-security.ts";
import { readRequestText, RequestBodyError } from "../_shared/request-body.ts";
import { deliverOtsStamp, StampDeliveryError } from "../_shared/ots-delivery.ts";

interface WebhookPayload {
  event_type: string;
  timestamp?: string;
  data: Record<string, unknown>;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    const response = errorResponse("Method not allowed", 405);
    response.headers.set("Allow", "POST, OPTIONS");
    return response;
  }

  // Keep PR #33's unconditional fail-closed configuration guard, before the
  // request body is read. No environment label disables provider authentication.
  if (!DOCUSEAL_WEBHOOK_SECRET) {
    return errorResponse("Webhook authentication unavailable", 503);
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) return errorResponse("Webhook storage unavailable", 503);
  if (!verifyBearerSecret(req.headers.get("authorization"), DOCUSEAL_WEBHOOK_SECRET) &&
      !hasHmacSignatureFormat(req.headers.get("x-docuseal-signature"))) {
    return errorResponse("Unauthorized", 401);
  }
  let rawBody: string;
  try {
    rawBody = await readRequestText(req, { maxBytes: 64 * 1024 });
    if (!await verifyDocusealWebhook(rawBody, req.headers, DOCUSEAL_WEBHOOK_SECRET)) {
      return errorResponse("Unauthorized", 401);
    }
  } catch (error) {
    return error instanceof RequestBodyError
      ? errorResponse(error.message, error.status)
      : errorResponse("Webhook authentication unavailable", 503);
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return errorResponse("Invalid request body", 400);
  }
  if (
    !payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.event_type !== "string" ||
    payload.event_type.length > 64 || !/^[a-z]+(?:[._][a-z]+)+$/.test(payload.event_type) ||
    !payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)
  ) {
    return errorResponse("Invalid webhook payload", 400);
  }

  const eventType = payload.event_type;
  const data = payload.data as Record<string, unknown>;
  const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  if ((data.id !== undefined && !positiveId(data.id)) || (data.submission_id !== undefined && !positiveId(data.submission_id))) {
    return errorResponse("Invalid webhook identifier", 400);
  }
  const submissionId = positiveId(data.submission_id) ? data.submission_id
    : eventType.startsWith("submission.") && positiveId(data.id) ? data.id : null;
  if (!positiveId(submissionId) || (eventType.startsWith("form.") && !positiveId(data.id))) {
    return errorResponse("Missing webhook identifier", 400);
  }


  console.log(`[webhook] event=${eventType}`);

  try {
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      db: { schema: "purama_ai" },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // Identifiers are validated before the privileged client is created.
    const { data: contract, error: loadError } = await supabaseAdmin
      .from("contracts")
      .select("id, status, user_id, app_slug, template_slug")
      .eq("docuseal_submission_id", submissionId)
      .maybeSingle();

    if (loadError) return errorResponse("Contract lookup failed", 500);

    if (!contract) {
      console.warn(`[webhook] contract not found for submission ${submissionId}`);
      return corsResponse({ ok: true, skip: "contract not found" });
    }
    if (typeof contract.id !== "string" || typeof contract.status !== "string") {
      return errorResponse("Invalid contract state", 500);
    }

    // ─── Handle each event type ─────────────────────────────────────
    switch (eventType) {
      case "form.viewed": {
        const submitterId = typeof data.id === "number" ? data.id : null;
        if (submitterId) {
          const { data: signer, error: signerError } = await supabaseAdmin.from("contract_signers")
            .update({ opened_at: new Date().toISOString() })
            .eq("docuseal_submitter_id", submitterId)
            .eq("contract_id", contract.id)
            .select("id")
            .maybeSingle();
          if (signerError) return errorResponse("Signer update failed", 500);
          if (!signer) return errorResponse("Contract signer not found", 409);
        }
        if (contract.status === "sent") {
          const { data: updated, error: updateError } = await supabaseAdmin.from("contracts")
            .update({ status: "opened" })
            .eq("id", contract.id)
            .eq("status", contract.status)
            .eq("docuseal_submission_id", submissionId)
            .select("id")
            .maybeSingle();
          if (updateError) return errorResponse("Contract update failed", 500);
          if (!updated) return errorResponse("Contract changed during delivery", 409);
        }
        const { error: eventError } = await supabaseAdmin.from("contract_events").insert({
          contract_id: contract.id, event_type: "opened",
          payload: { submitter_id: submitterId },
        });
        if (eventError) return errorResponse("Contract audit record failed", 500);
        break;
      }

      case "form.completed": {
        if (!["sent", "opened", "signed"].includes(contract.status)) {
          return errorResponse("Contract cannot accept a completion", 409);
        }
        const submitterId = typeof data.id === "number" ? data.id : null;
        if (submitterId) {
          const { data: signer, error: signerError } = await supabaseAdmin.from("contract_signers")
            .update({
              signed: true,
              signed_at: new Date().toISOString(),
              ip_address: typeof data.ip === "string" ? data.ip : null,
              user_agent: typeof data.ua === "string" ? data.ua : null,
            })
            .eq("docuseal_submitter_id", submitterId)
            .eq("contract_id", contract.id)
            .select("id")
            .maybeSingle();
          if (signerError) return errorResponse("Signer update failed", 500);
          if (!signer) return errorResponse("Contract signer not found", 409);
        }

        // Check if ALL signers have signed → mark contract signed
        const { data: signers, error: signerReadError } = await supabaseAdmin
          .from("contract_signers")
          .select("signed")
          .eq("contract_id", contract.id);
        if (signerReadError) return errorResponse("Contract signers lookup failed", 500);
        if (!Array.isArray(signers) || signers.length === 0) {
          return errorResponse("Contract signers unavailable", 409);
        }
        const allSigned = signers.every(s => s?.signed === true);

        if (allSigned) {
          // Fetch combined PDF URL from DocuSeal
          type DSSub = { combined_document_url?: string; audit_log_url?: string };
          const submission = await docusealFetch<DSSub>("GET", `/api/submissions/${submissionId}`);

          const { data: updated, error: updateError } = await supabaseAdmin.from("contracts")
            .update({
              status: "signed",
              signed_at: new Date().toISOString(),
              pdf_original_url: submission.combined_document_url ?? null,
            })
            .eq("id", contract.id)
            .eq("status", contract.status)
            .eq("docuseal_submission_id", submissionId)
            .select("id")
            .maybeSingle();
          if (updateError) return errorResponse("Contract update failed", 500);
          if (!updated) return errorResponse("Contract changed during delivery", 409);

          const { error: eventError } = await supabaseAdmin.from("contract_events").insert({
            contract_id: contract.id, event_type: "signed",
            payload: { pdf_url: submission.combined_document_url },
          });
          if (eventError) return errorResponse("Contract audit record failed", 500);

          // Every completed contract needs a delivery result, even when the
          // metadata omits a URL: the stamper resolves the signed PDF itself.
          // Already-signed contracts remain eligible when a delivery is retried.
          try {
            await deliverOtsStamp(supabaseUrl, serviceRoleKey, contract.id, { signal: req.signal });
          } catch (error) {
            console.error("[webhook] timestamp delivery failed");
            return errorResponse("Timestamp delivery failed", error instanceof StampDeliveryError ? error.status : 502);
          }
        } else {
          const { error: eventError } = await supabaseAdmin.from("contract_events").insert({
            contract_id: contract.id, event_type: "signed",
            payload: { submitter_id: submitterId, partial: true },
          });
          if (eventError) return errorResponse("Contract audit record failed", 500);
        }
        break;
      }

      case "form.declined": {
        if (!["sent", "opened", "declined"].includes(contract.status)) {
          return errorResponse("Contract cannot accept a decline", 409);
        }
        const submitterId = typeof data.id === "number" ? data.id : null;
        if (submitterId) {
          const { data: signer, error: signerError } = await supabaseAdmin.from("contract_signers")
            .update({ declined_at: new Date().toISOString() })
            .eq("docuseal_submitter_id", submitterId)
            .eq("contract_id", contract.id)
            .select("id")
            .maybeSingle();
          if (signerError) return errorResponse("Signer update failed", 500);
          if (!signer) return errorResponse("Contract signer not found", 409);
        }
        const { data: updated, error: updateError } = await supabaseAdmin.from("contracts")
          .update({ status: "declined", cancelled_at: new Date().toISOString() })
          .eq("id", contract.id)
          .eq("status", contract.status)
          .eq("docuseal_submission_id", submissionId)
          .select("id")
          .maybeSingle();
        if (updateError) return errorResponse("Contract update failed", 500);
        if (!updated) return errorResponse("Contract changed during delivery", 409);
        const { error: eventError } = await supabaseAdmin.from("contract_events").insert({
          contract_id: contract.id, event_type: "declined",
          payload: { submitter_id: submitterId, reason: data.decline_reason ?? null },
        });
        if (eventError) return errorResponse("Contract audit record failed", 500);
        break;
      }

      case "submission.created":
      case "submission.expired":
      case "form.started": {
        if (eventType === "submission.expired") {
          if (!["draft", "sent", "opened", "expired"].includes(contract.status)) {
            return errorResponse("Contract cannot accept an expiration", 409);
          }
          const { data: updated, error: updateError } = await supabaseAdmin.from("contracts")
            .update({ status: "expired", expires_at: new Date().toISOString() })
            .eq("id", contract.id)
            .eq("status", contract.status)
            .eq("docuseal_submission_id", submissionId)
            .select("id")
            .maybeSingle();
          if (updateError) return errorResponse("Contract update failed", 500);
          if (!updated) return errorResponse("Contract changed during delivery", 409);
        }
        const { error: eventError } = await supabaseAdmin.from("contract_events").insert({
          contract_id: contract.id,
          event_type: eventType === "submission.expired" ? "expired" : "opened",
          payload: data as Record<string, unknown>,
        });
        if (eventError) return errorResponse("Contract audit record failed", 500);
        break;
      }

      default:
        console.log(`[webhook] unhandled event: ${eventType}`);
    }

    return corsResponse({ ok: true, contract_id: contract.id });
  } catch {
    console.error("[webhook] processing failed");
    return errorResponse("Webhook processing failed", 500);
  }
});
