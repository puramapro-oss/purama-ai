// GET/POST /functions/v1/entraide-contact — demandes de contact sécurisées.
// POST /entraide-contact/:id/respond { response: "accept"|"decline"|"block" }
// Auth requise, verrou anti-doublon = index unique DB.

import { createClient } from "npm:@supabase/supabase-js@2.91.0";
import {
  assertEntraideRateLimit,
  entraideErrorResponse,
  EntraideHttpError,
  entraideJson,
  entraideRouteParts,
  readEntraideJson,
} from "../_shared/entraide-http.ts";
import { z } from "npm:zod@3.25.76";
import {
  canSendContactRequest,
  respondToContactRequest,
} from "@purama/entraide";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SendRequestSchema = z.object({
  recipient_id: z.string().uuid(),
  message: z.string().max(500).optional(),
});

const RespondSchema = z.object({
  response: z.enum(["accept", "decline", "block"]),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const pathParts = entraideRouteParts(req, "entraide-contact");
    const isRoot = pathParts.length === 0;
    const isRespond = pathParts.length === 2 && pathParts[1] === "respond";
    if (!isRoot && !isRespond) {
      throw new EntraideHttpError(404, "not_found", "Route introuvable");
    }
    if (
      (req.method !== "GET" && req.method !== "POST") ||
      (req.method === "GET" && !isRoot)
    ) {
      throw new EntraideHttpError(
        405,
        "method_not_allowed",
        "Méthode non supportée",
        {
          Allow: isRespond
            ? "POST, OPTIONS"
            : corsHeaders["Access-Control-Allow-Methods"],
        },
      );
    }
    const requestId = isRespond ? pathParts[0] : undefined;
    if (requestId && !z.string().uuid().safeParse(requestId).success) {
      throw new EntraideHttpError(
        400,
        "invalid_request",
        "Identifiant de demande invalide",
      );
    }
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new EntraideHttpError(
        401,
        "unauthenticated",
        "Authorization requise",
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
      db: { schema: "purama_ai" },
    });

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      throw new EntraideHttpError(401, "unauthenticated", "Non authentifié");
    }

    if (req.method === "GET") {
      assertEntraideRateLimit(user.id, "entraide-contact-list", 60);

      const { data, error } = await supabase
        .from("entraide_contact_requests")
        .select("*")
        .or(`requester_id.eq.${user.id},recipient_id.eq.${user.id}`)
        .order("created_at", { ascending: false });

      if (error) throw error;

      return entraideJson({ requests: data }, 200, corsHeaders);
    }

    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceKey) throw new Error("Missing contact service configuration");
    const supabaseService = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
      db: { schema: "purama_ai" },
    });

    if (req.method === "POST" && isRoot) {
      assertEntraideRateLimit(user.id, "entraide-contact-send", 15);

      const body = await readEntraideJson(req);
      const parsed = SendRequestSchema.safeParse(body);

      if (!parsed.success) {
        return entraideJson(
          {
            error: "invalid_request",
            message: "Données invalides",
            details: parsed.error.errors,
          },
          400,
          corsHeaders,
        );
      }

      // Reverse blocks are invisible through the caller's RLS client.
      const { data: isBlockedData, error: blockedError } = await supabaseService
        .from("entraide_blocages")
        .select("blocker_id")
        .or(
          `and(blocker_id.eq.${parsed.data.recipient_id},blocked_id.eq.${user.id}),and(blocker_id.eq.${user.id},blocked_id.eq.${parsed.data.recipient_id})`,
        )
        .limit(1)
        .maybeSingle();

      if (blockedError) throw blockedError;
      const isBlockedByRecipient = !!isBlockedData;

      const now = new Date();
      const today = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      const tomorrow = new Date(today.getTime() + 86_400_000);
      const { count, error: countError } = await supabase
        .from("entraide_contact_requests")
        .select("*", { count: "exact", head: true })
        .eq("requester_id", user.id)
        .gte("created_at", today.toISOString())
        .lt("created_at", tomorrow.toISOString());

      if (countError) throw countError;
      if (count === null) throw new Error("Contact request count unavailable");
      const requesterRequestsSentToday = count;

      const { data: pendingData, error: pendingError } = await supabase
        .from("entraide_contact_requests")
        .select("id")
        .eq("requester_id", user.id)
        .eq("recipient_id", parsed.data.recipient_id)
        .eq("status", "pending")
        .maybeSingle();

      if (pendingError) throw pendingError;
      const hasPendingRequestToSameRecipient = !!pendingData;

      const { data: lastDeclineData, error: declineError } = await supabase
        .from("entraide_contact_requests")
        .select("responded_at")
        .eq("requester_id", user.id)
        .eq("recipient_id", parsed.data.recipient_id)
        .in("status", ["declined", "expired"])
        .order("responded_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (declineError) throw declineError;
      const lastDeclineOrExpiryToSameRecipient = lastDeclineData?.responded_at
        ? new Date(lastDeclineData.responded_at)
        : null;

      const decision = canSendContactRequest({
        requesterId: user.id,
        recipientId: parsed.data.recipient_id,
        isBlockedByRecipient,
        requesterRequestsSentToday,
        hasPendingRequestToSameRecipient,
        lastDeclineOrExpiryToSameRecipient,
        now,
      });

      if (!decision.allowed) {
        throw new EntraideHttpError(
          400,
          "contact_not_allowed",
          decision.reason,
        );
      }

      // The pending-request unique index resolves duplicate sends. The daily
      // quota/check-and-insert sequence is NOT yet atomic across instances.
      const { data: newRequest, error: insertError } = await supabaseService
        .from("entraide_contact_requests")
        .insert({
          requester_id: user.id,
          recipient_id: parsed.data.recipient_id,
          message: parsed.data.message ?? null,
          status: "pending",
        })
        .select()
        .single();

      if (insertError?.code === "23505") {
        throw new EntraideHttpError(
          409,
          "contact_request_exists",
          "Une demande est déjà en attente",
        );
      }
      if (insertError) throw insertError;

      return entraideJson({ request: newRequest }, 200, corsHeaders);
    }

    if (req.method === "POST" && requestId && isRespond) {
      assertEntraideRateLimit(user.id, "entraide-contact-respond", 30);

      const body = await readEntraideJson(req);
      const parsed = RespondSchema.safeParse(body);

      if (!parsed.success) {
        return entraideJson(
          {
            error: "invalid_request",
            message: "Données invalides",
            details: parsed.error.errors,
          },
          400,
          corsHeaders,
        );
      }

      const { data: requestData, error: fetchError } = await supabase
        .from("entraide_contact_requests")
        .select("*")
        .eq("id", requestId)
        .eq("recipient_id", user.id)
        .maybeSingle();

      if (fetchError) throw fetchError;
      if (!requestData) {
        throw new EntraideHttpError(404, "not_found", "Demande introuvable");
      }
      if (requestData.status !== "pending") {
        throw new EntraideHttpError(
          409,
          "contact_not_pending",
          "Cette demande a déjà reçu une réponse",
        );
      }

      const result = respondToContactRequest(
        requestData.status,
        parsed.data.response,
      );

      if (!result.ok) {
        throw new EntraideHttpError(400, "contact_not_allowed", result.reason);
      }

      if (parsed.data.response === "accept") {
        const { data: blocked, error: blockedError } = await supabaseService
          .from("entraide_blocages")
          .select("blocker_id")
          .or(
            `and(blocker_id.eq.${requestData.requester_id},blocked_id.eq.${user.id}),and(blocker_id.eq.${user.id},blocked_id.eq.${requestData.requester_id})`,
          )
          .limit(1)
          .maybeSingle();
        if (blockedError) throw blockedError;
        if (blocked) {
          throw new EntraideHttpError(
            409,
            "contact_unavailable",
            "Contact indisponible",
          );
        }
      }

      if (parsed.data.response === "block") {
        // Persist the protective block first; never report success if it failed.
        // Block + response still require a future atomic RPC for all race cases.
        const { error: blockError } = await supabaseService
          .from("entraide_blocages")
          .upsert(
            { blocker_id: user.id, blocked_id: requestData.requester_id },
            {
              onConflict: "blocker_id,blocked_id",
              ignoreDuplicates: true,
            },
          );
        if (blockError) throw blockError;
      }

      const { data: updatedRequest, error: updateError } = await supabaseService
        .from("entraide_contact_requests")
        .update({
          status: result.status,
          responded_at: new Date().toISOString(),
        })
        .eq("id", requestId)
        .eq("recipient_id", user.id)
        .eq("status", "pending")
        .select()
        .maybeSingle();

      if (updateError) throw updateError;
      if (!updatedRequest) {
        throw new EntraideHttpError(
          409,
          "contact_not_pending",
          "Cette demande a déjà reçu une réponse",
        );
      }

      return entraideJson({ request: updatedRequest }, 200, corsHeaders);
    }

    throw new EntraideHttpError(
      405,
      "method_not_allowed",
      "Méthode non supportée",
    );
  } catch (error) {
    if (!(error instanceof EntraideHttpError)) {
      console.error("Erreur entraide-contact:", error);
    }
    return entraideErrorResponse(error, corsHeaders);
  }
});
