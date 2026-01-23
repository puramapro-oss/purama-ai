import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.91.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { conversationId, userEmail, userMessage, conversationHistory } = await req.json();

    if (!conversationId || !userMessage) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Mark conversation as escalated
    await supabase
      .from("chat_conversations")
      .update({ escalated: true, status: "escalated" })
      .eq("id", conversationId);

    // Send notification email via Resend
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (RESEND_API_KEY) {
      const emailBody = `
        <h2>🚨 Escalade Support Chat - Purama</h2>
        <p><strong>Conversation ID:</strong> ${conversationId}</p>
        <p><strong>Email utilisateur:</strong> ${userEmail || "Non fourni"}</p>
        <p><strong>Dernier message:</strong></p>
        <blockquote style="background: #f5f5f5; padding: 10px; border-left: 3px solid #6366f1;">
          ${userMessage}
        </blockquote>
        <h3>Historique de la conversation:</h3>
        <div style="background: #fafafa; padding: 15px; border-radius: 8px;">
          ${conversationHistory?.map((msg: any) => `
            <p><strong>${msg.role === "user" ? "👤 Utilisateur" : "🤖 Purama AI"}:</strong> ${msg.content}</p>
          `).join("") || "Pas d'historique disponible"}
        </div>
        <p style="margin-top: 20px;">
          <a href="https://purama.app/admin" style="background: #6366f1; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
            Voir dans l'admin
          </a>
        </p>
      `;

      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Purama Support <support@purama.app>",
          to: ["support@purama.app"],
          subject: `[Escalade Chat] Demande de support humain - ${conversationId.slice(0, 8)}`,
          html: emailBody,
        }),
      });
    }

    return new Response(
      JSON.stringify({ success: true, message: "Escalade envoyée avec succès" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("Escalate error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Erreur inconnue" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
