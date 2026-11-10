import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { rateLimit } from "../_shared/rate-limit.ts";
import { streamAnthropicChat } from "../_shared/anthropic-stream.ts";
import { prepareChatMessages } from "../_shared/chat-input.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // Authentication check
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Non autorisé" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { db: { schema: 'purama_ai' }, global: { headers: { Authorization: authHeader } } }
    );

    const token = authHeader.replace("Bearer ", "");
    const { data, error: authError } = await supabaseClient.auth.getUser(token);
    
    if (authError || !data?.user) {
      return new Response(JSON.stringify({ error: "Non autorisé" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = data.user.id;

    // Rate limiting (20 req/hour)
    const rateLimitResult = rateLimit(`chat:${userId}`, 20, 3600000);
    if (!rateLimitResult.allowed) {
      return new Response(JSON.stringify({ error: "Trop de tentatives. Réessaie dans 1 heure." }), {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    // Preserve this authenticated endpoint's existing 50 x 4,000 contract.
    // These limits are server-owned; callers cannot raise them in the body.
    const prepared = prepareChatMessages(body?.messages, {
      maxMessages: 50, maxMessageLength: 4_000, maxTotalLength: 200_000,
    });
    if (prepared.ok === false) return new Response(JSON.stringify({ error: prepared.error }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
    const messages = prepared.messages;
    req.signal.throwIfAborted();

    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_API_KEY) {
      console.error("ANTHROPIC_API_KEY is not configured");
      return new Response(JSON.stringify({ error: "Service temporairement indisponible" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Chat request from user ${userId} with ${messages.length} messages`);

    const response = await streamAnthropicChat({
      signal: req.signal,
      apiKey: ANTHROPIC_API_KEY,
      model: Deno.env.get("ANTHROPIC_MODEL_MAIN") ?? "claude-sonnet-4-6",
      systemPrompt: `Tu es PURA, l'assistant IA de PURAMA ONE. Aide la personne dans ses questions, ses projets et, si elle le souhaite, son bien-être ou sa recherche de sens.
Réponds à sa demande actuelle avec une aide concrète. Ne transforme pas une demande personnelle en argumentaire commercial. Tu peux expliquer les services seulement si c'est pertinent et demandé; aucun tarif, quota, gain ou catalogue actuel vérifié n'est fourni ici.
Cette conversation produit du texte. Elle ne réalise pas d'action externe, ne contacte pas de personne et ne modifie pas de mémoire ou de compte. Indique les limites réelles de ce canal.`,
      messages,
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Limite de requêtes atteinte, réessayez plus tard." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await response.text();
      console.error("Anthropic API error:", response.status, t);
      return new Response(JSON.stringify({ error: "Erreur du service IA" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, ...Object.fromEntries(response.headers) },
    });
  } catch (e) {
    console.error("chat error:", e);
    return new Response(JSON.stringify({ error: "Erreur inconnue" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
