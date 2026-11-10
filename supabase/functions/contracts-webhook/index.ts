// POST /functions/v1/contracts-webhook
// Receives DocuSeal webhooks on submission lifecycle events.
// Validates HMAC signature, updates contracts + contract_signers, triggers OTS stamping.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.91.0";
import {
  CORS_HEADERS, corsResponse, errorResponse,
  DOCUSEAL_WEBHOOK_SECRET, docusealFetch,
} from "../_shared/docuseal.ts";
import { verifyBearerSecret, verifyDocusealWebhook } from "../_shared/webhook-security.ts";
import { readRequestText, RequestBodyError } from "../_shared/request-body.ts";

interface WebhookPayload {
  event_type: string;
  timestamp?: string;
  data: Record<string, unknown>;
}

serve(async (req) => {
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
      !req.headers.get("x-docuseal-signature")) {
    return errorResponse("Unauthorized", 401);
  }
  let rawBody: string;
  try {
    rawBody = await readRequestText(req);
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
    !payload || typeof payload !== "object" || typeof payload.event_type !== "string" ||
    !payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)
  ) {
    return errorResponse("Invalid webhook payload", 400);
  }

  const eventType = payload.event_type;
  const data = payload.data as Record<string, unknown>;
  console.log(`[webhook] event=${eventType}`, { data_keys: Object.keys(data) });

  try {
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      db: { schema: "purama_ai" },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // Find the contract by submission_id
    const submissionId = typeof data.submission_id === "number" ? data.submission_id
                      : typeof data.id === "number" && eventType.startsWith("submission.") ? data.id
                      : null;
    if (!submissionId) {
      console.warn("[webhook] no submission_id in payload", { event_type: eventType, data_keys: Object.keys(data) });
      return corsResponse({ ok: true, skip: "no submission_id" });
    }

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

          // Trigger OTS stamping async (fire-and-forget)
          if (supabaseUrl && submission.combined_document_url) {
            fetch(`${supabaseUrl}/functions/v1/contracts-ots-stamp`, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${serviceRoleKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ contract_id: contract.id }),
            }).catch(e => console.error("[webhook] OTS stamp trigger failed:", e));
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
  } catch (err) {
    console.error("[webhook] processing error:", err);
    return errorResponse("Webhook processing failed", 500);
  }
});
