import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-webhook-secret",
};

const jsonResponse = (body: Record<string, unknown>, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve((req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const expectedSecret = Deno.env.get("WEBHOOK_SECRET");
  if (!expectedSecret) {
    console.error(
      "[PROCESS-INFLUENCER-PAYMENTS] WEBHOOK_SECRET is not configured",
    );
    return jsonResponse({ error: "Service de paiement indisponible" }, 503);
  }

  if (req.headers.get("x-webhook-secret") !== expectedSecret) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // No payout provider is wired in this repository. Never mutate commissions or
  // announce a transfer until a provider returns a durable transfer identifier.
  console.error(
    "[PROCESS-INFLUENCER-PAYMENTS] Aucun prestataire de virement configuré; aucune commission modifiée",
  );
  return jsonResponse(
    {
      success: false,
      error: "Aucun prestataire de virement configuré",
      processed: 0,
    },
    503,
  );
});
