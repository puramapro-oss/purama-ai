import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { rateLimit } from "../_shared/rate-limit.ts";
import { validateBody, KartaTriggerSchema } from "../_shared/validation.ts";

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
 * Proxy authentifié entre le frontend et l'API interne KARTA Engine (protégée par KARTA_ADMIN_TOKEN,
 * un secret serveur qui ne doit jamais atteindre le navigateur). Utilisé par l'onboarding
 * "Embauche ton premier employé IA" et par la page "Mes employés IA" pour déclencher un cycle réel.
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

    // 10 déclenchements manuels / heure / user : suffisant pour l'onboarding + réglages, bloque l'abus.
    const rateLimitResult = rateLimit(`karta-trigger:${userId}`, 10, 3600000);
    if (!rateLimitResult.allowed) {
      return json({ error: "Trop de déclenchements. Réessaie dans un moment." }, 429);
    }

    const body = await req.json().catch(() => ({}));
    const validation = validateBody(KartaTriggerSchema, body);
    if (!validation.ok) {
      return json({ error: validation.error }, 400);
    }
    const { agentType } = validation.data;

    const kartaUrl = Deno.env.get("KARTA_INTERNAL_URL");
    const kartaToken = Deno.env.get("KARTA_ADMIN_TOKEN");
    if (!kartaUrl || !kartaToken) {
      console.error("karta-trigger: KARTA_INTERNAL_URL ou KARTA_ADMIN_TOKEN non configuré");
      return json({ error: "Service employés IA temporairement indisponible" }, 500);
    }

    const kartaResponse = await fetch(`${kartaUrl}/trigger/${agentType}/${userId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${kartaToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!kartaResponse.ok) {
      const text = await kartaResponse.text();
      console.error(`karta-trigger: KARTA a répondu ${kartaResponse.status}: ${text}`);
      return json({ error: "Impossible de déclencher l'employé IA" }, 502);
    }

    const result = await kartaResponse.json();
    return json({ ok: true, ...result });
  } catch (e) {
    console.error("karta-trigger error:", e);
    return json({ error: "Erreur inconnue" }, 500);
  }
});
