// POST /functions/v1/contracts-webhook
// Receives DocuSeal webhooks on submission lifecycle events.
// Validates the configured shared-secret Bearer token, then processes bounded JSON.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.91.0";
import {
  CORS_HEADERS, corsResponse, errorResponse,
  DOCUSEAL_WEBHOOK_SECRET, docusealFetch,
} from "../_shared/docuseal.ts";
import { readOtsBody, OtsHttpError } from "../_shared/ots-body.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  if (!DOCUSEAL_WEBHOOK_SECRET) return errorResponse("Webhook authentication not configured", 503);

  // ─── Verify shared-secret Bearer token ──────────────────────────
  // DocuSeal community uses WebhookUrl.secret as raw HTTP headers (not HMAC).
  // We configure Authorization: Bearer <DOCUSEAL_WEBHOOK_SECRET> on the DocuSeal side
  // and validate it here via constant-time equality.
  if (DOCUSEAL_WEBHOOK_SECRET) {
    const authHeader = req.headers.get("authorization") ?? "";
    const expected = `Bearer ${DOCUSEAL_WEBHOOK_SECRET}`;
    let match = authHeader.length === expected.length;
    if (match) {
      let diff = 0;
      for (let i = 0; i < authHeader.length; i++) {
        diff |= authHeader.charCodeAt(i) ^ expected.charCodeAt(i);
      }
      match = diff === 0;
    }
    if (!match) {
      console.error("[webhook] Invalid bearer token");
      return errorResponse("Invalid signature", 401);
    }
  }

  let payload: Record<string, unknown>;
  try { payload = await readOtsBody(req, 64 * 1024); }
  catch (error) { return errorResponse(error instanceof OtsHttpError ? error.message : "Invalid JSON", error instanceof OtsHttpError ? error.status : 400); }
  if (typeof payload.event_type !== "string" || payload.event_type.length > 64
    || !/^[a-z]+(?:[._][a-z]+)+$/.test(payload.event_type)
    || !payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
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

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { db: { schema: "purama_ai" } },
  );

  console.log(`[webhook] event=${eventType}`);

  try {
    // The submission identifier is validated before creating the privileged client.
    const { data: contract } = await supabaseAdmin
      .from("contracts")
      .select("id, status, user_id, app_slug, template_slug")
      .eq("docuseal_submission_id", submissionId)
      .maybeSingle();

    if (!contract) {
      console.warn(`[webhook] contract not found for submission ${submissionId}`);
      return corsResponse({ ok: true, skip: "contract not found" });
    }

    // ─── Handle each event type ─────────────────────────────────────
    switch (eventType) {
      case "form.viewed": {
        const submitterId = typeof data.id === "number" ? data.id : null;
        if (submitterId) {
          await supabaseAdmin.from("contract_signers")
            .update({ opened_at: new Date().toISOString() })
            .eq("docuseal_submitter_id", submitterId);
        }
        if (contract.status === "sent") {
          await supabaseAdmin.from("contracts")
            .update({ status: "opened" })
            .eq("id", contract.id);
        }
        await supabaseAdmin.from("contract_events").insert({
          contract_id: contract.id, event_type: "opened",
          payload: { submitter_id: submitterId },
        });
        break;
      }

      case "form.completed": {
        const submitterId = typeof data.id === "number" ? data.id : null;
        if (submitterId) {
          await supabaseAdmin.from("contract_signers")
            .update({
              signed: true,
              signed_at: new Date().toISOString(),
              ip_address: typeof data.ip === "string" ? data.ip : null,
              user_agent: typeof data.ua === "string" ? data.ua : null,
            })
            .eq("docuseal_submitter_id", submitterId);
        }

        // Check if ALL signers have signed → mark contract signed
        const { data: signers } = await supabaseAdmin
          .from("contract_signers")
          .select("signed")
          .eq("contract_id", contract.id);
        const allSigned = Array.isArray(signers) && signers.length > 0 && signers.every((s: { signed: boolean }) => s.signed);

        if (allSigned) {
          // Fetch combined PDF URL from DocuSeal
          type DSSub = { combined_document_url?: string; audit_log_url?: string };
          const submission = await docusealFetch<DSSub>("GET", `/api/submissions/${submissionId}`);

          await supabaseAdmin.from("contracts")
            .update({
              status: "signed",
              signed_at: new Date().toISOString(),
              pdf_original_url: submission.combined_document_url ?? null,
            })
            .eq("id", contract.id);

          await supabaseAdmin.from("contract_events").insert({
            contract_id: contract.id, event_type: "signed",
            payload: { pdf_url: submission.combined_document_url },
          });

          // Trigger OTS stamping async (fire-and-forget)
          const supabaseUrl = Deno.env.get("SUPABASE_URL");
          if (supabaseUrl && submission.combined_document_url) {
            fetch(`${supabaseUrl}/functions/v1/contracts-ots-stamp`, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ contract_id: contract.id }),
            }).catch(e => console.error("[webhook] OTS stamp trigger failed:", e));
          }
        } else {
          await supabaseAdmin.from("contract_events").insert({
            contract_id: contract.id, event_type: "signed",
            payload: { submitter_id: submitterId, partial: true },
          });
        }
        break;
      }

      case "form.declined": {
        const submitterId = typeof data.id === "number" ? data.id : null;
        if (submitterId) {
          await supabaseAdmin.from("contract_signers")
            .update({ declined_at: new Date().toISOString() })
            .eq("docuseal_submitter_id", submitterId);
        }
        await supabaseAdmin.from("contracts")
          .update({ status: "declined", cancelled_at: new Date().toISOString() })
          .eq("id", contract.id);
        await supabaseAdmin.from("contract_events").insert({
          contract_id: contract.id, event_type: "declined",
          payload: { submitter_id: submitterId, reason: data.decline_reason ?? null },
        });
        break;
      }

      case "submission.created":
      case "submission.expired":
      case "form.started":
        await supabaseAdmin.from("contract_events").insert({
          contract_id: contract.id,
          event_type: eventType === "submission.expired" ? "expired" : "opened",
          payload: data as Record<string, unknown>,
        });
        if (eventType === "submission.expired") {
          await supabaseAdmin.from("contracts")
            .update({ status: "expired", expires_at: new Date().toISOString() })
            .eq("id", contract.id);
        }
        break;

      default:
        console.log(`[webhook] unhandled event: ${eventType}`);
    }

    return corsResponse({ ok: true, contract_id: contract.id });
  } catch (err) {
    console.error("[webhook] processing error:", err);
    return errorResponse(`Webhook processing failed: ${(err as Error).message}`, 500);
  }
});
