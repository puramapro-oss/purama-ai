import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.91.0";
import { rateLimit } from "../_shared/rate-limit.ts";
import { streamAnthropicChat } from "../_shared/anthropic-stream.ts";
import { json } from "../_shared/response.ts";

/**
 * Démo publique sans inscription (brief "PRICING & OFFRE IRRÉSISTIBLE") : un visiteur décrit une
 * situation d'email pro, l'employé IA Email de Purama AI rédige un vrai brouillon en direct
 * (vrai appel Claude — pas de setTimeout ni de résultat fabriqué). Aucune action réelle (0 envoi,
 * 0 écriture DB utilisateur) : uniquement génératif, donc sûr pour un visiteur anonyme.
 *
 * Double plafond de coût pour un endpoint public non authentifié qui appelle Claude en direct :
 * rate limit en mémoire par IP (1ère ligne, bon marché) + quota journalier global atomique en base
 * (increment_demo_quota, migration 20260727030000) qui survit aux redéploiements et aux isolates
 * concurrents — le rate limit en mémoire seul ne suffit pas (cf ERRORS.md 2026-07-27).
 */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `Tu es l'employé IA "Email" de Purama AI, en mode démonstration publique gratuite (sans inscription).

## Tâche
Le visiteur décrit une situation d'email professionnel. Rédige un brouillon d'email complet, prêt à
être adapté, en français professionnel.

## Règles
1. Réponds UNIQUEMENT avec l'email (objet + corps), sans commentaire ni explication autour
2. Utilise des placeholders génériques entre crochets si des infos manquent (ex: [Nom du client], [Montant])
3. Reste concis : email réaliste de 80-150 mots maximum
4. Ne jamais inventer de vraies coordonnées, montants ou noms d'entreprise réels
5. Termine par une formule de politesse professionnelle standard`;

const MIN_LENGTH = 5;
const MAX_LENGTH = 300;
const MAX_DEMO_CALLS_PER_DAY = 200;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Démo publique anonyme : rate limit strict par IP (5/heure) — pas de compte, donc pas de user_id.
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const rateLimitResult = rateLimit(`ai-demo:${clientIp}`, 5, 3600000);
    if (!rateLimitResult.allowed) {
      return json({ error: "Limite d'essais gratuits atteinte. Réessaie dans 1 heure, ou crée un compte pour un accès illimité." }, 429);
    }

    const { situation } = await req.json();
    if (typeof situation !== "string" || situation.trim().length < MIN_LENGTH || situation.length > MAX_LENGTH) {
      return json({ error: `Décris ta situation en ${MIN_LENGTH} à ${MAX_LENGTH} caractères.` }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { db: { schema: "purama_ai" } }
    );
    const { data: withinDailyQuota, error: quotaError } = await supabaseAdmin.rpc(
      "increment_demo_quota",
      { p_max_per_day: MAX_DEMO_CALLS_PER_DAY }
    );
    if (quotaError) {
      console.error("[ai-demo] increment_demo_quota failed:", quotaError.message);
    } else if (withinDailyQuota === false) {
      return json({ error: "Démo indisponible pour aujourd'hui (quota gratuit atteint). Crée un compte pour un accès illimité." }, 429);
    }

    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not configured");
    }

    // Tâche simple à contexte court → modèle rapide (cf routage Haiku/Sonnet, ERRORS.md 2026-07-27).
    const response = await streamAnthropicChat({
      apiKey: ANTHROPIC_API_KEY,
      model: Deno.env.get("ANTHROPIC_MODEL_FAST") ?? "claude-haiku-4-5-20251001",
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: situation.trim() }],
      maxTokens: 400,
    });

    if (!response.ok) {
      if (response.status === 429) {
        return json({ error: "Service IA temporairement saturé, réessaie dans quelques instants." }, 429);
      }
      const errorText = await response.text();
      console.error("[ai-demo] Anthropic API error:", response.status, errorText);
      return json({ error: "Erreur du service IA. Réessaie dans quelques instants." }, 500);
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": response.headers.get("Content-Type") ?? "text/event-stream" },
    });
  } catch (e) {
    console.error("[ai-demo] error:", e);
    return json({ error: e instanceof Error ? e.message : "Erreur inconnue" }, 500);
  }
});
