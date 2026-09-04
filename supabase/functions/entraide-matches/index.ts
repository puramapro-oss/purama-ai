// GET /functions/v1/entraide-matches — suggestions de mise en relation triées par score desc.
// Auth requise. Retourne uniquement les profils avec score > 0 (exclusion stricte, pas juste tri).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { json } from "../_shared/response.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { computeMatchScore } from "https://esm.sh/@purama/entraide@1.0.0";
import type { WeekDay } from "https://esm.sh/@purama/entraide@1.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Authorization requise" }, { status: 401, headers: corsHeaders });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
      db: { schema: "purama_ai" },
    });

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return json({ error: "Non authentifié" }, { status: 401, headers: corsHeaders });
    }

    await rateLimit(supabase, user.id, "entraide-matches", 30);

    const { data: myProfil, error: myError } = await supabase
      .from("entraide_profils")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (myError) throw myError;
    if (!myProfil) {
      return json({ matches: [] }, { headers: corsHeaders });
    }

    const { data: myBlocked, error: blockedError } = await supabase
      .from("entraide_blocages")
      .select("blocked_id")
      .eq("blocker_id", user.id);

    if (blockedError) throw blockedError;

    const { data: allProfils, error: allError } = await supabase
      .from("entraide_profils")
      .select("*")
      .neq("user_id", user.id);

    if (allError) throw allError;

    const myProfile = {
      userId: user.id,
      skillsOffered: myProfil.skills_offered ?? [],
      skillsNeeded: myProfil.skills_needed ?? [],
      availabilityDays: (myProfil.availability_days ?? []) as WeekDay[],
      radiusKm: myProfil.radius_km,
      location:
        myProfil.location_lat !== null && myProfil.location_lng !== null
          ? { lat: myProfil.location_lat, lng: myProfil.location_lng }
          : null,
      blockedUserIds: myBlocked?.map((b) => b.blocked_id) ?? [],
    };

    const scored = await Promise.all(
      (allProfils ?? []).map(async (p) => {
        const { data: theirBlocked } = await supabase
          .from("entraide_blocages")
          .select("blocked_id")
          .eq("blocker_id", p.user_id);

        const theirProfile = {
          userId: p.user_id,
          skillsOffered: p.skills_offered ?? [],
          skillsNeeded: p.skills_needed ?? [],
          availabilityDays: (p.availability_days ?? []) as WeekDay[],
          radiusKm: p.radius_km,
          location:
            p.location_lat !== null && p.location_lng !== null
              ? { lat: p.location_lat, lng: p.location_lng }
              : null,
          blockedUserIds: theirBlocked?.map((b) => b.blocked_id) ?? [],
        };

        const { score, reasons } = computeMatchScore(myProfile, theirProfile);

        return { userId: p.user_id, score, reasons };
      })
    );

    const matches = scored.filter((m) => m.score > 0).sort((a, b) => b.score - a.score);

    return json({ matches }, { headers: corsHeaders });
  } catch (error) {
    console.error("Erreur entraide-matches:", error);
    return json(
      { error: error instanceof Error ? error.message : "Erreur serveur" },
      { status: 500, headers: corsHeaders }
    );
  }
});
