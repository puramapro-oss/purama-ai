import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.91.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `Tu es Purama AI, l'assistant virtuel intelligent de Purama, une plateforme française d'agents IA professionnels.

## Ton identité
- Nom : Purama AI
- Personnalité : Amical, professionnel, serviable et enthousiaste
- Langue : Français (tu peux répondre en anglais si on te parle en anglais)
- Style : Concis mais complet, utilise des emojis avec parcimonie (1-2 max par message)

## Tes connaissances sur Purama
- 45 agents IA spécialisés (Marketing, Ventes, Finance, RH, Productivité, Création)
- Tarifs : Starter 33€/mois (3 agents), Premium 99€/mois (illimité), -20% annuel
- Intégrations : Google (Gmail, Calendar), Microsoft, CRM, outils marketing
- Programme affiliation : 9.99% Bronze → 19.99% Silver → 33% Gold, -50% pour les filleuls

## Règles importantes
1. Si tu trouves une réponse dans la base de connaissances fournie, utilise-la en priorité
2. Sois toujours positif et orienté solution
3. Si tu ne sais pas ou si c'est un problème technique complexe, propose de contacter le support humain
4. Propose des liens vers les pages pertinentes quand c'est utile
5. Détecte l'intention de l'utilisateur : achat, support, information, problème technique
6. Termine tes réponses par une question ou proposition d'aide supplémentaire

## Format de réponse
- Utilise le markdown pour structurer (gras, listes)
- Garde tes réponses concises (max 200 mots sauf si détails demandés)
- Propose des suggestions de questions en fin de réponse si pertinent`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { messages, conversationId, sessionId, pageContext } = await req.json();

    // Input validation
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: "Messages array is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (messages.length > 50) {
      return new Response(
        JSON.stringify({ error: "Too many messages" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate message format
    for (const msg of messages) {
      if (!msg.role || !["user", "assistant", "system"].includes(msg.role)) {
        return new Response(
          JSON.stringify({ error: "Invalid message role" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (!msg.content || typeof msg.content !== "string" || msg.content.length > 5000) {
        return new Response(
          JSON.stringify({ error: "Invalid message content" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get the last user message for knowledge base search
    const lastUserMessage = messages.filter(m => m.role === "user").pop()?.content || "";

    // Search knowledge base for relevant answers
    let knowledgeContext = "";
    if (lastUserMessage) {
      const searchTerms: string[] = lastUserMessage.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2);
      
      const { data: knowledgeResults } = await supabase
        .from("chatbot_knowledge")
        .select("question, reponse, categorie")
        .limit(5);

      if (knowledgeResults && knowledgeResults.length > 0) {
        // Simple keyword matching
        const matches = knowledgeResults.filter((kb: { question: string; reponse: string; categorie: string }) => {
          const content = `${kb.question} ${kb.reponse}`.toLowerCase();
          return searchTerms.some((term: string) => content.includes(term));
        }).slice(0, 3);

        if (matches.length > 0) {
          knowledgeContext = `\n\n## Base de connaissances pertinente\n${matches.map((kb: { question: string; reponse: string }) => 
            `**Q:** ${kb.question}\n**R:** ${kb.reponse}`
          ).join("\n\n")}`;
        }
      }
    }

    // Add page context to system prompt
    let contextualPrompt = SYSTEM_PROMPT;
    if (pageContext) {
      contextualPrompt += `\n\n## Contexte actuel\nL'utilisateur est sur la page : ${pageContext}`;
    }
    contextualPrompt += knowledgeContext;

    // Call Lovable AI
    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: contextualPrompt },
          ...messages,
        ],
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Limite de requêtes atteinte, réessayez dans quelques instants." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "Service temporairement indisponible." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const errorText = await response.text();
      console.error("AI gateway error:", response.status, errorText);
      return new Response(
        JSON.stringify({ error: "Erreur du service IA" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("Chatbot error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Erreur inconnue" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
