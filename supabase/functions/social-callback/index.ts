import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/zernio.ts";
import { verifySocialCallbackState } from "../_shared/social-state.ts";

const APP_URL = Deno.env.get("APP_URL") || "https://purama-ai.purama.dev";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const platform = url.searchParams.get("platform");
    // R1 Red Team : `user_id` n'est plus lu en clair depuis la query string —
    // seul un jeton signe/expirant emis par social-connect est accepte, sinon
    // n'importe quel appelant pouvait lier son propre compte social au user_id
    // d'une victime (callback jamais authentifie, upsert service-role).
    const stateSecret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const userId = await verifySocialCallbackState(url.searchParams.get("state"), stateSecret);
    const profileId =
      url.searchParams.get("profile_id") ||
      url.searchParams.get("zernio_profile_id");
    const accountId =
      url.searchParams.get("account_id") ||
      url.searchParams.get("zernio_account_id") ||
      profileId;
    const accountName =
      url.searchParams.get("account_name") ||
      url.searchParams.get("name") ||
      "";
    const accountUsername =
      url.searchParams.get("username") ||
      url.searchParams.get("account_username") ||
      "";
    const error = url.searchParams.get("error");

    if (error) {
      return Response.redirect(
        `${APP_URL}/dashboard/social?error=${encodeURIComponent(error)}`,
        302,
      );
    }

    if (!platform || !userId || !profileId) {
      return Response.redirect(
        `${APP_URL}/dashboard/social?error=missing_params`,
        302,
      );
    }

    const supabaseAdmin = createClient(
      
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { db: { schema: 'purama_ai' } }
    );

    const { error: upsertError } = await supabaseAdmin
      .from("social_accounts")
      .upsert(
        {
          user_id: userId,
          platform,
          zernio_profile_id: profileId,
          zernio_account_id: accountId,
          account_name: accountName,
          account_username: accountUsername,
          is_active: true,
          connected_at: new Date().toISOString(),
        },
        { onConflict: "user_id,platform" },
      );

    if (upsertError) {
      console.error("[social-callback] upsert error:", upsertError);
      return Response.redirect(
        `${APP_URL}/dashboard/social?error=${encodeURIComponent(upsertError.message)}`,
        302,
      );
    }

    return Response.redirect(
      `${APP_URL}/dashboard/social?connected=${platform}`,
      302,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[social-callback]", message);
    return Response.redirect(
      `${APP_URL}/dashboard/social?error=${encodeURIComponent(message)}`,
      302,
    );
  }
});
