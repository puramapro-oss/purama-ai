import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { rateLimit } from "../_shared/rate-limit.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Approuve ou rejette une action KARTA en attente de validation humaine (cf brief §Sécurité,
 * autonomie graduée niveau 1/2). Approuver déclenche une VRAIE exécution de l'outil côté KARTA
 * Engine (argent, envoi email, signature...) — la vérification de propriété ci-dessous est donc
 * la seule barrière avant l'appel serveur-à-serveur avec KARTA_ADMIN_TOKEN.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "Non autorisé" }, 401);
    }

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { db: { schema: "purama_ai" }, global: { headers: { Authorization: authHeader } } }
    );

    const token = authHeader.replace("Bearer ", "");
    const { data, error: authError } = await supabaseClient.auth.getUser(token);
    if (authError || !data?.user) {
      return json({ error: "Non autorisé" }, 401);
    }
    const userId = data.user.id;

    const rateLimitResult = rateLimit(`karta-resolve-pending-action:${userId}`, 30, 3600000);
    if (!rateLimitResult.allowed) {
      return json({ error: "Trop de tentatives. Réessaie dans un moment." }, 429);
    }

    const body = await req.json().catch(() => ({}));
    const pendingActionId = typeof body?.pendingActionId === "string" ? body.pendingActionId : null;
    const decision = body?.decision === "approve" || body?.decision === "reject" ? body.decision : null;
    if (!pendingActionId || !/^[0-9a-f-]{36}$/i.test(pendingActionId) || !decision) {
      return json({ error: "Paramètres invalides" }, 400);
    }

    // RLS (SELECT policy karta_pending_actions) restreint déjà ce SELECT à user_id = auth.uid() —
    // ligne introuvable = soit inexistante, soit appartenant à un autre utilisateur (403 implicite).
    const { data: pending, error: pendingError } = await supabaseClient
      .from("karta_pending_actions")
      .select("id, status")
      .eq("id", pendingActionId)
      .maybeSingle();

    if (pendingError || !pending) {
      return json({ error: "Action introuvable" }, 404);
    }
    if (pending.status !== "pending") {
      return json({ error: "Cette action a déjà été traitée" }, 409);
    }

    const kartaUrl = Deno.env.get("KARTA_INTERNAL_URL");
    const kartaToken = Deno.env.get("KARTA_ADMIN_TOKEN");
    if (!kartaUrl || !kartaToken) {
      console.error("karta-resolve-pending-action: KARTA_INTERNAL_URL ou KARTA_ADMIN_TOKEN non configuré");
      return json({ error: "Service employés IA temporairement indisponible" }, 500);
    }

    const kartaResponse = await fetch(`${kartaUrl}/pending-actions/${pendingActionId}/${decision}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${kartaToken}`, "Content-Type": "application/json" },
    });

    if (!kartaResponse.ok) {
      const text = await kartaResponse.text();
      console.error(`karta-resolve-pending-action: KARTA a répondu ${kartaResponse.status}: ${text}`);
      return json({ error: "Impossible de traiter cette action" }, 502);
    }

    const result = await kartaResponse.json();
    return json({ ok: true, ...result });
  } catch (e) {
    console.error("karta-resolve-pending-action error:", e);
    return json({ error: "Erreur inconnue" }, 500);
  }
});
