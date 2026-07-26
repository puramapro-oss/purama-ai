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
 * Déclenche manuellement ("Tester maintenant") un agent créé par un utilisateur (Agent Créateur
 * d'Agents, cf brief §Phase 4) via KARTA Engine. Contrairement à `karta-trigger` (les 12 agents
 * "action" fixes, whitelist statique), l'id ici est arbitraire (n'importe quel `creator_agents.id`)
 * — la sécurité repose donc sur la vérification explicite de propriété ci-dessous, pas sur une
 * whitelist de valeurs. KARTA_ADMIN_TOKEN reste 100% serveur.
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

    const rateLimitResult = rateLimit(`karta-trigger-custom:${userId}`, 10, 3600000);
    if (!rateLimitResult.allowed) {
      return json({ error: "Trop de déclenchements. Réessaie dans un moment." }, 429);
    }

    const body = await req.json().catch(() => ({}));
    const agentId = typeof body?.agentId === "string" ? body.agentId : null;
    if (!agentId || !/^[0-9a-f-]{36}$/i.test(agentId)) {
      return json({ error: "agentId invalide" }, 400);
    }

    // Vérification de propriété AVANT tout appel à KARTA — l'API interne fait confiance à l'appelant
    // (elle n'a pas connaissance de qui est réellement authentifié côté navigateur), donc cette
    // vérification est la seule barrière empêchant un user de déclencher l'agent d'un autre.
    const { data: agent, error: agentError } = await supabaseClient
      .from("creator_agents")
      .select("id, user_id, karta_enabled")
      .eq("id", agentId)
      .maybeSingle();

    if (agentError || !agent) {
      return json({ error: "Agent introuvable" }, 404);
    }
    if (agent.user_id !== userId) {
      return json({ error: "Non autorisé" }, 403);
    }
    if (!agent.karta_enabled) {
      return json({ error: "Cet agent n'est pas activé en mode exécution réelle" }, 400);
    }

    const kartaUrl = Deno.env.get("KARTA_INTERNAL_URL");
    const kartaToken = Deno.env.get("KARTA_ADMIN_TOKEN");
    if (!kartaUrl || !kartaToken) {
      console.error("karta-trigger-custom: KARTA_INTERNAL_URL ou KARTA_ADMIN_TOKEN non configuré");
      return json({ error: "Service employés IA temporairement indisponible" }, 500);
    }

    const kartaResponse = await fetch(`${kartaUrl}/trigger-custom/${agentId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${kartaToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!kartaResponse.ok) {
      const text = await kartaResponse.text();
      console.error(`karta-trigger-custom: KARTA a répondu ${kartaResponse.status}: ${text}`);
      return json({ error: "Impossible de déclencher l'agent" }, 502);
    }

    const result = await kartaResponse.json();
    return json({ ok: true, ...result });
  } catch (e) {
    console.error("karta-trigger-custom error:", e);
    return json({ error: "Erreur inconnue" }, 500);
  }
});
