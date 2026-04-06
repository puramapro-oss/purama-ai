import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const N8N_BASE_URL = "https://n8n.srv1286148.hstgr.cloud/webhook";

// Demo mode: simulate responses when n8n workflows are not active
const DEMO_MODE_ENABLED = false;

// Generate demo responses based on agent category and form data
function generateDemoResponse(agentSlug: string, formData: Record<string, unknown>): Record<string, unknown> {
  const demoResponses: Record<string, (data: Record<string, unknown>) => Record<string, unknown>> = {
    // CRM & Sales
    "crm-intelligent": (data) => ({
      status: "success",
      message: `Lead "${data.nom_lead || data.name || 'Contact'}" ajouté avec succès au CRM`,
      lead_id: `LEAD-${Date.now()}`,
      score: Math.floor(Math.random() * 40) + 60,
      next_action: "Relance automatique programmée dans 3 jours",
      demo_mode: true,
    }),
    "conclueur-de-vente": (data) => ({
      status: "success",
      message: "Analyse de vente générée",
      closing_probability: `${Math.floor(Math.random() * 30) + 70}%`,
      recommended_actions: [
        "Proposer une remise de 10%",
        "Mettre en avant les témoignages clients",
        "Planifier un appel de suivi",
      ],
      demo_mode: true,
    }),
    "buteur-principal": (data) => ({
      status: "success",
      message: "Scoring du lead effectué",
      lead_score: Math.floor(Math.random() * 40) + 60,
      qualification: "Qualifié",
      priority: "Haute",
      demo_mode: true,
    }),

    // Chatbots
    "bot-whatsapp": (data) => ({
      status: "success",
      message: "Message WhatsApp simulé envoyé",
      to: data.numero || "+33600000000",
      template: "greeting_template",
      scheduled: new Date(Date.now() + 60000).toISOString(),
      demo_mode: true,
    }),
    "bot-de-messagerie": (data) => ({
      status: "success",
      message: "Bot Messenger configuré",
      response_template: "Bienvenue ! Comment puis-je vous aider ?",
      auto_replies_enabled: true,
      demo_mode: true,
    }),
    "bot-de-messagerie-instagram": (data) => ({
      status: "success",
      message: "Bot Instagram DM activé",
      auto_response: "Merci pour votre message ! Notre équipe vous répondra bientôt.",
      demo_mode: true,
    }),
    "chatbot-de-site-web": (data) => ({
      status: "success",
      message: "Widget chatbot généré",
      widget_id: `CHAT-${Date.now()}`,
      embed_code: `<script src="https://chat.example.com/widget.js" data-id="CHAT-${Date.now()}"></script>`,
      demo_mode: true,
    }),

    // Support
    "faq-intelligente": (data) => ({
      status: "success",
      message: "Réponse FAQ générée",
      question: data.question || "Question utilisateur",
      answer: "Voici une réponse détaillée basée sur notre base de connaissances. Notre service offre une gamme complète de fonctionnalités pour répondre à vos besoins professionnels.",
      confidence: 0.92,
      related_questions: [
        "Comment démarrer ?",
        "Quels sont les tarifs ?",
        "Comment contacter le support ?",
      ],
      demo_mode: true,
    }),
    "booster-de-critiques": (data) => ({
      status: "success",
      message: "Campagne d'avis lancée",
      emails_sent: 25,
      sms_sent: 10,
      expected_reviews: 8,
      demo_mode: true,
    }),

    // Finance
    "facture-pro": (data) => ({
      status: "success",
      message: "Facture générée avec succès",
      invoice_number: `FAC-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 9999)).padStart(4, '0')}`,
      client: data.client_nom || data.client || "Client",
      amount: data.montant || 0,
      due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      pdf_url: "https://example.com/invoice.pdf",
      demo_mode: true,
    }),
    "chasseur-de-paiements": (data) => ({
      status: "success",
      message: "Relances programmées",
      invoices_tracked: 5,
      total_outstanding: "€12,450.00",
      next_reminder: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      demo_mode: true,
    }),
    "calculateur-d-impot": (data) => ({
      status: "success",
      message: "Calcul fiscal effectué",
      estimated_tax: "€4,250.00",
      optimization_tips: [
        "Déduction possible pour investissement",
        "Crédit d'impôt innovation applicable",
      ],
      demo_mode: true,
    }),
    "rapports-financiers": (data) => ({
      status: "success",
      message: "Rapport financier généré",
      report_type: "Bilan mensuel",
      period: new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }),
      revenue: "€45,000",
      expenses: "€32,000",
      profit: "€13,000",
      demo_mode: true,
    }),

    // Marketing
    "contenu-social": (data) => ({
      status: "success",
      message: "Contenu social généré",
      posts: [
        { platform: "LinkedIn", content: "🚀 Découvrez notre nouvelle fonctionnalité..." },
        { platform: "Twitter", content: "Nouveau ! Notre outil simplifie votre quotidien #innovation" },
        { platform: "Instagram", content: "✨ La productivité n'a jamais été aussi simple" },
      ],
      demo_mode: true,
    }),
    "hashtags-viraux": (data) => ({
      status: "success",
      message: "Hashtags optimisés générés",
      hashtags: ["#entrepreneur", "#business", "#innovation", "#success", "#startup"],
      engagement_prediction: "Élevé",
      demo_mode: true,
    }),
    "gestionnaire-de-communaute": (data) => ({
      status: "success",
      message: "Analyse communautaire effectuée",
      active_members: 1250,
      engagement_rate: "8.5%",
      trending_topics: ["Nouvelles fonctionnalités", "Témoignages", "Astuces"],
      demo_mode: true,
    }),
    "influenceurs-pro": (data) => ({
      status: "success",
      message: "Influenceurs identifiés",
      matches: [
        { name: "Influenceur A", followers: "50K", engagement: "4.2%" },
        { name: "Influenceur B", followers: "120K", engagement: "3.8%" },
      ],
      demo_mode: true,
    }),
    "maitre-des-publicites": (data) => ({
      status: "success",
      message: "Campagne publicitaire optimisée",
      recommended_budget: "€500/jour",
      target_audience: "Professionnels 25-45 ans",
      expected_reach: "50,000 personnes",
      demo_mode: true,
    }),
    "seo-dominator": (data) => ({
      status: "success",
      message: "Audit SEO complété",
      score: 72,
      issues: ["Meta descriptions manquantes", "Images non optimisées"],
      opportunities: ["Mots-clés longue traîne", "Backlinks à acquérir"],
      demo_mode: true,
    }),
    "espion-concurrent": (data) => ({
      status: "success",
      message: "Analyse concurrentielle effectuée",
      competitors_analyzed: 5,
      market_position: "3ème",
      opportunities: ["Prix compétitif", "Fonctionnalité unique manquante chez concurrents"],
      demo_mode: true,
    }),
    "oracle-des-tendances": (data) => ({
      status: "success",
      message: "Tendances identifiées",
      trends: ["IA générative", "Automatisation", "Durabilité"],
      recommendation: "Investir dans l'IA conversationnelle",
      demo_mode: true,
    }),
    "predicteur-de-tendances": (data) => ({
      status: "success",
      message: "Prédictions de marché",
      growth_sectors: ["Tech", "Santé", "Énergie verte"],
      declining_sectors: ["Retail traditionnel"],
      demo_mode: true,
    }),

    // Email
    "campagnes-par-courriel": (data) => ({
      status: "success",
      message: "Campagne email créée",
      campaign_id: `CAMP-${Date.now()}`,
      recipients: 500,
      scheduled_for: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      demo_mode: true,
    }),
    "newsletter-genie": (data) => ({
      status: "success",
      message: "Newsletter générée",
      subject: "Votre newsletter hebdomadaire",
      preview: "Découvrez les dernières actualités...",
      word_count: 450,
      demo_mode: true,
    }),
    "pro-de-la-sensibilisation-au-froid": (data) => ({
      status: "success",
      message: "Séquence cold email créée",
      emails_in_sequence: 5,
      personalization_score: "Élevé",
      demo_mode: true,
    }),

    // Admin
    "assistant-administratif": (data) => ({
      status: "success",
      message: "Tâche administrative traitée",
      tasks_created: 3,
      reminders_set: 2,
      demo_mode: true,
    }),
    "commandant-de-tache": (data) => ({
      status: "success",
      message: "Tâches organisées",
      total_tasks: 12,
      completed: 8,
      pending: 4,
      demo_mode: true,
    }),
    "organisateur-de-documents": (data) => ({
      status: "success",
      message: "Documents classés",
      documents_processed: 15,
      categories: ["Contrats", "Factures", "Rapports"],
      demo_mode: true,
    }),
    "gestionnaire-d-archives": (data) => ({
      status: "success",
      message: "Archives mises à jour",
      archived_items: 50,
      storage_saved: "2.5 GB",
      demo_mode: true,
    }),
    "remplisseur-de-formulaire": (data) => ({
      status: "success",
      message: "Formulaire pré-rempli",
      fields_filled: 12,
      accuracy: "98%",
      demo_mode: true,
    }),

    // Legal
    "conseiller-juridique-ia": (data) => ({
      status: "success",
      message: "Analyse juridique effectuée",
      risk_level: "Modéré",
      recommendations: [
        "Consulter un avocat pour validation",
        "Ajouter clause de non-responsabilité",
      ],
      demo_mode: true,
    }),
    "rgpd-guardian": (data) => ({
      status: "success",
      message: "Audit RGPD complété",
      compliance_score: 78,
      issues: ["Consentement cookies", "Politique confidentialité à mettre à jour"],
      demo_mode: true,
    }),

    // Sales
    "machine-de-suivi": (data) => ({
      status: "success",
      message: "Relances programmées",
      follow_ups_scheduled: 8,
      next_action: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      demo_mode: true,
    }),
    "planificateur-d-appels": (data) => ({
      status: "success",
      message: "Appels planifiés",
      calls_scheduled: 5,
      next_call: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      demo_mode: true,
    }),
  };

  // Get the specific demo handler or use a generic one
  const handler = demoResponses[agentSlug];
  
  if (handler) {
    return handler(formData);
  }

  // Generic demo response for unknown agents
  return {
    status: "success",
    message: `Agent "${agentSlug}" exécuté en mode démo`,
    input_received: formData,
    timestamp: new Date().toISOString(),
    demo_mode: true,
  };
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { agentSlug, formData } = await req.json();

    if (!agentSlug) {
      return new Response(
        JSON.stringify({ success: false, error: "agentSlug is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const authHeader = req.headers.get("Authorization");
    
    const supabase = createClient(supabaseUrl, supabaseKey, { db: { schema: 'purama_ai' }, global: { headers: authHeader ? { Authorization: authHeader } : {} },
    });

    // Get user from auth header if available
    let userId = "anonymous";
    let userEmail = "anonymous@user.com";
    
    if (authHeader) {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        userId = user.id;
        userEmail = user.email || "no-email@user.com";
      }
    }

    // Fetch webhook_slug from agents table
    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .select("webhook_slug, slug, category")
      .eq("slug", agentSlug)
      .single();

    if (agentError || !agent) {
      console.error("Agent not found:", agentSlug, agentError);
      return new Response(
        JSON.stringify({ success: false, error: `Agent '${agentSlug}' non trouvé` }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use webhook_slug if available, otherwise fallback to slug directly (no prefix)
    const webhookSlug = agent.webhook_slug || agent.slug;
    const webhookUrl = `${N8N_BASE_URL}/${webhookSlug}`;

    // Prepare payload for n8n - use simple format with message field
    const payload = {
      message: formData.message || JSON.stringify(formData),
      agentSlug,
      user_id: userId,
      userEmail,
      timestamp: new Date().toISOString(),
    };

    console.log(`Calling n8n webhook (POST): ${webhookUrl}`);

    // Call n8n webhook with POST method
    const n8nResponse = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const responseText = await n8nResponse.text();
    
    // Try to parse as JSON
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(responseText);
    } catch {
      parsedResponse = { message: responseText };
    }

    // Check if n8n returned an error
    if (!n8nResponse.ok) {
      console.error(`n8n error: ${n8nResponse.status} - ${responseText}`);
      
      // Handle specific n8n errors - use demo mode if enabled
      if (n8nResponse.status === 404 && DEMO_MODE_ENABLED) {
        console.log(`n8n workflow not active, using demo mode for agent: ${agentSlug}`);
        const demoData = generateDemoResponse(agentSlug, formData || {});
        
        return new Response(
          JSON.stringify({
            success: true,
            data: demoData,
            demo_mode: true,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      // If demo mode is disabled or other error, return error
      if (n8nResponse.status === 404) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Le workflow n8n n'est pas actif ou n'existe pas. Veuillez activer le workflow dans n8n.",
            details: parsedResponse,
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      return new Response(
        JSON.stringify({
          success: false,
          error: `Erreur n8n: ${n8nResponse.status}`,
          details: parsedResponse,
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Success - extract the response field if available, otherwise return full response
    const responseData = parsedResponse.response || parsedResponse;
    
    return new Response(
      JSON.stringify({
        success: true,
        data: responseData,
        raw: parsedResponse,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Agent proxy error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || "Une erreur est survenue",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
