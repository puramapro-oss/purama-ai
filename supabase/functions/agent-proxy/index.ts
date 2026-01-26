import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const N8N_BASE_URL = "https://n8n.srv1286148.hstgr.cloud/webhook";

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

    // Get user from auth header if available
    let userId = "anonymous";
    let userEmail = "anonymous@user.com";
    
    const authHeader = req.headers.get("Authorization");
    if (authHeader) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
      const supabase = createClient(supabaseUrl, supabaseKey, {
        global: { headers: { Authorization: authHeader } },
      });
      
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        userId = user.id;
        userEmail = user.email || "no-email@user.com";
      }
    }

    // Build webhook URL
    const webhookUrl = `${N8N_BASE_URL}/agent-${agentSlug}`;

    // Prepare payload for n8n
    const payload = {
      agentSlug,
      user_id: userId,
      userEmail,
      timestamp: new Date().toISOString(),
      ...formData,
    };

    // Build query params from payload
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === "object") {
        queryParams.append(key, JSON.stringify(value));
      } else {
        queryParams.append(key, String(value));
      }
    }
    
    const getUrl = `${webhookUrl}?${queryParams.toString()}`;
    console.log(`Calling n8n webhook (GET): ${webhookUrl}`);

    // Call n8n webhook with GET method
    const n8nResponse = await fetch(getUrl, { method: "GET" });

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
      
      // Handle specific n8n errors
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

    // Success - return n8n response
    return new Response(
      JSON.stringify({
        success: true,
        data: parsedResponse,
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
