// POST /functions/v1/contracts-create
// Create a new DocuSeal submission + purama_ai.contracts row.
// Auth: user JWT (Authorization: Bearer ...) OR service JWT (X-Purama-Service-Token).
//
// Body:
// {
//   app_slug: string,
//   template_slug: string,
//   signer: { email, name, phone? },
//   metadata?: Record<string, unknown>,
//   variables?: Record<string, string>,
//   redirect_url?: string
// }

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.91.0";
import {
  CORS_HEADERS, corsResponse, errorResponse,
  DOCUSEAL_URL, DOCUSEAL_TOKEN, docusealFetch,
  verifyCrossAppJwt,
} from "../_shared/docuseal.ts";

interface CreateContractBody {
  app_slug: string;
  template_slug: string;
  signer: { email: string; name: string; phone?: string };
  metadata?: Record<string, unknown>;
  variables?: Record<string, string>;
  redirect_url?: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const body = await req.json() as CreateContractBody;

    if (!body.app_slug || !body.template_slug || !body.signer?.email || !body.signer?.name) {
      return errorResponse("Missing required fields: app_slug, template_slug, signer.email, signer.name");
    }

    // ─── Identify caller: user JWT OR cross-app service JWT ─────────
    const serviceToken = req.headers.get("x-purama-service-token");
    const authHeader = req.headers.get("authorization");

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { db: { schema: "purama_ai" } },
    );

    let actingUserId: string;
    let callerApp = body.app_slug;
    let callerType: "user" | "service" = "user";

    if (serviceToken) {
      // Cross-app service call — verify JWT
      const secrets = [
        Deno.env.get("PURAMA_SERVICE_SECRET_V1") ?? "",
        Deno.env.get("PURAMA_SERVICE_SECRET_V2") ?? "",
      ].filter(Boolean);
      if (secrets.length === 0) return errorResponse("PURAMA_SERVICE_SECRET not configured", 500);
      try {
        const payload = await verifyCrossAppJwt(serviceToken, secrets);
        callerApp = payload.app_slug;
        callerType = "service";
        // For service calls, we need the user_id in body.metadata.user_id
        const metaUserId = (body.metadata?.user_id as string | undefined);
        if (!metaUserId) return errorResponse("metadata.user_id required for service calls");
        actingUserId = metaUserId;
      } catch (e) {
        return errorResponse(`Service JWT invalid: ${(e as Error).message}`, 401);
      }
    } else if (authHeader?.startsWith("Bearer ")) {
      const supabaseClient = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_ANON_KEY") ?? "",
        { db: { schema: "purama_ai" } },
      );
      const { data: { user } } = await supabaseClient.auth.getUser(authHeader.slice(7));
      if (!user) return errorResponse("Unauthenticated", 401);
      actingUserId = user.id;
    } else {
      return errorResponse("Missing auth — provide Authorization: Bearer <user_jwt> or x-purama-service-token", 401);
    }

    // ─── Look up template + docuseal_template_id ────────────────────
    const { data: template, error: tplErr } = await supabaseAdmin
      .from("contract_templates")
      .select("docuseal_template_id, name, tier_required")
      .eq("slug", body.template_slug)
      .eq("active", true)
      .maybeSingle();
    if (tplErr) return errorResponse(`Template lookup failed: ${tplErr.message}`, 500);
    if (!template?.docuseal_template_id) {
      return errorResponse(`Template not found or inactive: ${body.template_slug}`, 404);
    }

    // ─── Create DocuSeal submission ─────────────────────────────────
    const submissionPayload = {
      template_id: template.docuseal_template_id,
      send_email: true,
      redirect_url: body.redirect_url ?? `https://${callerApp}.purama.dev/contracts/success`,
      submitters: [
        {
          email: "contracts@purama.dev",
          name: "Matiss DORNIER",
          role: "Purama",
          // Auto-complete for Purama rep (predefined values)
          values: {},
        },
        {
          email: body.signer.email,
          name: body.signer.name,
          phone: body.signer.phone,
          role: "Ambassadeur",
          values: body.variables ?? {},
        },
      ],
      message: {
        subject: `Signature requise : ${template.name}`,
        body: `Bonjour ${body.signer.name},\n\nVotre contrat ${template.name} est prêt à être signé. Cliquez sur le lien dans cet e-mail pour accéder à votre espace de signature sécurisé.\n\nL'équipe Purama`,
      },
    };

    type DSSubmitter = { id: number; email: string; slug: string; role: string; submission_id?: number };

    // DocuSeal returns an array of SUBMITTERS (one per recipient), not a wrapped Submission.
    // All submitters share the same submission_id.
    const response = await docusealFetch<DSSubmitter[]>("POST", "/api/submissions", submissionPayload);
    const submittersArr: DSSubmitter[] = Array.isArray(response) ? response : [];
    if (submittersArr.length === 0) {
      return errorResponse("DocuSeal submission creation failed", 502, response);
    }
    const submissionId = submittersArr[0].submission_id ?? submittersArr[0].id;
    const sub = { id: submissionId, submitters: submittersArr };
    if (!sub.id) return errorResponse("DocuSeal submission has no id", 502, response);

    // ─── Insert purama_ai.contracts row ─────────────────────────────
    const commissionRate = body.variables?.commission_rate
      ? parseFloat(body.variables.commission_rate)
      : null;

    const { data: contract, error: insertErr } = await supabaseAdmin
      .from("contracts")
      .insert({
        user_id: actingUserId,
        app_slug: callerApp,
        template_slug: body.template_slug,
        status: "sent",
        docuseal_submission_id: sub.id,
        docuseal_template_id: template.docuseal_template_id,
        commission_rate: commissionRate,
        metadata: {
          ...(body.metadata ?? {}),
          caller_type: callerType,
          signer_email: body.signer.email,
          signer_name: body.signer.name,
        },
        sent_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (insertErr) {
      // Best-effort cleanup DocuSeal submission
      await docusealFetch("DELETE", `/api/submissions/${sub.id}`).catch(() => {});
      return errorResponse(`DB insert failed: ${insertErr.message}`, 500);
    }

    // ─── Insert signer rows ─────────────────────────────────────────
    for (const [idx, submitter] of sub.submitters.entries()) {
      await supabaseAdmin.from("contract_signers").insert({
        contract_id: contract.id,
        email: submitter.email,
        name: submitter.email === "contracts@purama.dev" ? "Matiss DORNIER" : body.signer.name,
        role: submitter.role === "Purama" ? "purama_rep" : "ambassadeur",
        order_index: idx,
        docuseal_submitter_id: submitter.id,
      });
    }

    // Audit event
    await supabaseAdmin.from("contract_events").insert({
      contract_id: contract.id,
      event_type: "created",
      payload: { caller_type: callerType, template_slug: body.template_slug },
      actor_id: callerType === "user" ? actingUserId : null,
      actor_type: callerType,
    });
    await supabaseAdmin.from("contract_events").insert({
      contract_id: contract.id,
      event_type: "sent",
      payload: { submission_id: sub.id },
    });

    return corsResponse({
      contract_id: contract.id,
      docuseal_submission_id: sub.id,
      signing_urls: sub.submitters.map(s => ({
        email: s.email,
        role: s.role,
        url: `${DOCUSEAL_URL}/s/${s.slug}`,
      })),
      status: "sent",
    }, 201);
  } catch (err) {
    console.error("[contracts-create] error:", err);
    return errorResponse(`Internal error: ${(err as Error).message}`, 500);
  }
});
