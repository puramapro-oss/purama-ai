import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.91.0";
import { escapeHtml } from "../_shared/html.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type SafeMessage = { role: "user" | "assistant"; content: string };

function parseRequestBody(value: unknown): {
  conversationId: string;
  userMessage: string;
  conversationHistory: SafeMessage[];
} | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (typeof body.conversationId !== "string" || !UUID_PATTERN.test(body.conversationId)) return null;
  if (typeof body.userMessage !== "string" || body.userMessage.trim().length < 1 || body.userMessage.length > 5_000) return null;
  if (body.conversationHistory !== undefined && !Array.isArray(body.conversationHistory)) return null;
  const history = body.conversationHistory ?? [];
  if (history.length > 20) return null;
  const messages: SafeMessage[] = [];
  for (const item of history) {
    if (!item || typeof item !== "object") return null;
    const message = item as Record<string, unknown>;
    if ((message.role !== "user" && message.role !== "assistant") ||
      typeof message.content !== "string" || message.content.length > 5_000) return null;
    messages.push({ role: message.role, content: message.content });
  }
  return {
    conversationId: body.conversationId,
    userMessage: body.userMessage.trim(),
    conversationHistory: messages,
  };
}

function json(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") return json("Method not allowed", 405);

  try {
    const authorization = req.headers.get("authorization");
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) return json("Unauthorized", 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) return json("Service unavailable", 503);

    const authClient = createClient(supabaseUrl, supabaseAnonKey);
    const { data: authData, error: authError } = await authClient.auth.getUser(match[1]);
    if (authError || !authData.user) return json("Unauthorized", 401);

    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return json("Invalid request", 400);
    }
    const body = parseRequestBody(rawBody);
    if (!body) return json("Invalid request", 400);

    const supabase = createClient(
      supabaseUrl,
      supabaseServiceKey,
      { db: { schema: 'purama_ai' } }
    );

    const { data: conversation, error: conversationError } = await supabase
      .from("chat_conversations")
      .select("id,user_id")
      .eq("id", body.conversationId)
      .maybeSingle();
    if (conversationError) return json("Unable to verify conversation", 500);
    if (!conversation || conversation.user_id !== authData.user.id) return json("Conversation not found", 404);

    // Mark conversation as escalated
    const { error: updateError } = await supabase
      .from("chat_conversations")
      .update({ escalated: true, status: "escalated" })
      .eq("id", body.conversationId)
      .eq("user_id", authData.user.id);
    if (updateError) return json("Unable to escalate conversation", 500);

    // Send notification email via Resend
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (RESEND_API_KEY) {
      const emailBody = `
        <h2>🚨 Escalade Support Chat - Purama</h2>
        <p><strong>Conversation ID:</strong> ${escapeHtml(body.conversationId)}</p>
        <p><strong>Email utilisateur:</strong> ${escapeHtml(authData.user.email || "Non fourni")}</p>
        <p><strong>Dernier message:</strong></p>
        <blockquote style="background: #f5f5f5; padding: 10px; border-left: 3px solid #6366f1;">
          ${escapeHtml(body.userMessage)}
        </blockquote>
        <h3>Historique de la conversation:</h3>
        <div style="background: #fafafa; padding: 15px; border-radius: 8px;">
          ${body.conversationHistory.map((msg) => `
            <p><strong>${msg.role === "user" ? "👤 Utilisateur" : "🤖 Purama AI"}:</strong> ${escapeHtml(msg.content)}</p>
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
          subject: `[Escalade Chat] Demande de support humain - ${body.conversationId.slice(0, 8)}`,
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
    return json("Internal server error", 500);
  }
});
