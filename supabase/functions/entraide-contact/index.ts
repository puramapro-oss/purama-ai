// GET/POST /functions/v1/entraide-contact — demandes de contact sécurisées.
// POST /entraide-contact/:id/respond { response: "accept"|"decline"|"block" }
// Auth requise, verrou anti-doublon = index unique DB.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { json } from "../_shared/response.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import {
  canSendContactRequest,
  respondToContactRequest,
  MAX_CONTACT_REQUESTS_PER_DAY,
  COOLDOWN_AFTER_DECLINE_DAYS,
} from "https://esm.sh/@purama/entraide@1.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Authorization requise" }, { status: 401, headers: corsHeaders });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
      db: { schema: "purama_ai" },
    });

    const supabaseService = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
      db: { schema: "purama_ai" },
    });

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return json({ error: "Non authentifié" }, { status: 401, headers: corsHeaders });
    }

    const url = new URL(req.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const requestId = pathParts[pathParts.indexOf("entraide-contact") + 1];
    const action = pathParts[pathParts.indexOf("entraide-contact") + 2];

    if (req.method === "GET") {
      await rateLimit(supabase, user.id, "entraide-contact-list", 60);

      const { data, error } = await supabase
        .from("entraide_contact_requests")
        .select("*")
        .or(`requester_id.eq.${user.id},recipient_id.eq.${user.id}`)
        .order("created_at", { ascending: false });

      if (error) throw error;

      return json({ requests: data }, { headers: corsHeaders });
    }

    if (req.method === "POST" && !requestId) {
      await rateLimit(supabase, user.id, "entraide-contact-send", 15);

      const body = await req.json();
      const parsed = SendRequestSchema.safeParse(body);

      if (!parsed.success) {
        return json(
          { error: "Données invalides", details: parsed.error.errors },
          { status: 400, headers: corsHeaders }
        );
      }

      const { data: isBlockedData } = await supabase
        .from("entraide_blocages")
        .select("blocker_id")
        .eq("blocker_id", parsed.data.recipient_id)
        .eq("blocked_id", user.id)
        .maybeSingle();

      const isBlockedByRecipient = !!isBlockedData;

      const today = new Date().toISOString().split("T")[0];
      const { count } = await supabase
        .from("entraide_contact_requests")
        .select("*", { count: "exact", head: true })
        .eq("requester_id", user.id)
        .gte("created_at", `${today}T00:00:00Z`)
        .lt("created_at", `${today}T23:59:59Z`);

      const requesterRequestsSentToday = count ?? 0;

      const { data: pendingData } = await supabase
        .from("entraide_contact_requests")
        .select("id")
        .eq("requester_id", user.id)
        .eq("recipient_id", parsed.data.recipient_id)
        .eq("status", "pending")
        .maybeSingle();

      const hasPendingRequestToSameRecipient = !!pendingData;

      const { data: lastDeclineData } = await supabase
        .from("entraide_contact_requests")
        .select("responded_at")
        .eq("requester_id", user.id)
        .eq("recipient_id", parsed.data.recipient_id)
        .in("status", ["declined", "expired"])
        .order("responded_at", { ascending: false })
        .limit(1)
        .maybeSingle();

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
        now: new Date(),
      });

      if (!decision.allowed) {
        return json({ error: decision.reason }, { status: 400, headers: corsHeaders });
      }

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

      if (insertError) throw insertError;

      return json({ request: newRequest }, { headers: corsHeaders });
    }

    if (req.method === "POST" && requestId && action === "respond") {
      await rateLimit(supabase, user.id, "entraide-contact-respond", 30);

      const body = await req.json();
      const parsed = RespondSchema.safeParse(body);

      if (!parsed.success) {
        return json(
          { error: "Données invalides", details: parsed.error.errors },
          { status: 400, headers: corsHeaders }
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
        return json({ error: "Demande introuvable" }, { status: 404, headers: corsHeaders });
      }

      const result = respondToContactRequest(requestData.status, parsed.data.response);

      if (!result.ok) {
        return json({ error: result.reason }, { status: 400, headers: corsHeaders });
      }

      const { error: updateError } = await supabaseService
        .from("entraide_contact_requests")
        .update({ status: result.status, responded_at: new Date().toISOString() })
        .eq("id", requestId);

      if (updateError) throw updateError;

      if (parsed.data.response === "block") {
        await supabaseService
          .from("entraide_blocages")
          .insert({ blocker_id: user.id, blocked_id: requestData.requester_id });
      }

      return json({ request: { ...requestData, status: result.status } }, { headers: corsHeaders });
    }

    return json({ error: "Méthode non supportée" }, { status: 405, headers: corsHeaders });
  } catch (error) {
    console.error("Erreur entraide-contact:", error);
    return json(
      { error: error instanceof Error ? error.message : "Erreur serveur" },
      { status: 500, headers: corsHeaders }
    );
  }
});
