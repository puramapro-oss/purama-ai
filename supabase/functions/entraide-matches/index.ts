// GET /functions/v1/entraide-matches — suggestions de mise en relation triées par score desc.
// Auth requise. Retourne uniquement les profils avec score > 0 (exclusion stricte, pas juste tri).

import { createClient } from "npm:@supabase/supabase-js@2.91.0";
import {
  assertEntraideRateLimit,
  entraideErrorResponse,
  EntraideHttpError,
  entraideJson,
  entraideRouteParts,
} from "../_shared/entraide-http.ts";
import { computeMatchScore } from "@purama/entraide";
import type { WeekDay } from "@purama/entraide";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (entraideRouteParts(req, "entraide-matches").length !== 0) {
      throw new EntraideHttpError(404, "not_found", "Route introuvable");
    }
    if (req.method !== "GET") {
      throw new EntraideHttpError(
        405,
        "method_not_allowed",
        "Méthode non supportée",
        {
          Allow: corsHeaders["Access-Control-Allow-Methods"],
        },
      );
    }
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new EntraideHttpError(
        401,
        "unauthenticated",
        "Authorization requise",
      );
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
      throw new EntraideHttpError(401, "unauthenticated", "Non authentifié");
    }

    assertEntraideRateLimit(user.id, "entraide-matches", 30);

    // Coordinates are private. Read them only server-side after user authentication,
    // and never include them in the response or grant them to authenticated clients.
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceKey) throw new Error("Missing matching service configuration");
    const supabaseService = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
      db: { schema: "purama_ai" },
    });
    const profileColumns =
      "user_id, skills_offered, skills_needed, availability_days, radius_km, location_lat, location_lng";
    const { data: myProfil, error: myError } = await supabaseService
      .from("entraide_profils")
      .select(profileColumns)
      .eq("user_id", user.id)
      .maybeSingle();

    if (myError) throw myError;
    if (!myProfil) {
      return entraideJson({ matches: [] }, 200, corsHeaders);
    }

    // The caller's RLS client cannot see who blocked them. One privileged query
    // covers both directions without exposing the block list to the caller.
    const { data: blocks, count: blockCount, error: blockedError } =
      await supabaseService
        .from("entraide_blocages")
        .select("blocker_id, blocked_id", { count: "exact" })
        .or(`blocker_id.eq.${user.id},blocked_id.eq.${user.id}`);

    if (blockedError) throw blockedError;
    // Fail closed if the API row cap truncated the security filter.
    if (blockCount === null || (blocks?.length ?? 0) !== blockCount) {
      throw new EntraideHttpError(
        503,
        "matching_unavailable",
        "Suggestions temporairement indisponibles",
      );
    }
    const blockedIds = new Set<string>(
      (blocks ?? []).map((block) =>
        block.blocker_id === user.id ? block.blocked_id : block.blocker_id
      ),
    );

    const { data: allProfils, error: allError } = await supabaseService
      .from("entraide_profils")
      .select(profileColumns)
      .neq("user_id", user.id);

    if (allError) throw allError;

    const myProfile = {
      userId: user.id,
      skillsOffered: myProfil.skills_offered ?? [],
      skillsNeeded: myProfil.skills_needed ?? [],
      availabilityDays: (myProfil.availability_days ?? []) as WeekDay[],
      radiusKm: myProfil.radius_km,
      location: myProfil.location_lat !== null && myProfil.location_lng !== null
        ? { lat: myProfil.location_lat, lng: myProfil.location_lng }
        : null,
      blockedUserIds: [...blockedIds],
    };

    const scored = (allProfils ?? [])
      .filter((profil) => !blockedIds.has(profil.user_id))
      .map((p) => {
        const theirProfile = {
          userId: p.user_id,
          skillsOffered: p.skills_offered ?? [],
          skillsNeeded: p.skills_needed ?? [],
          availabilityDays: (p.availability_days ?? []) as WeekDay[],
          radiusKm: p.radius_km,
          location: p.location_lat !== null && p.location_lng !== null
            ? { lat: p.location_lat, lng: p.location_lng }
            : null,
          blockedUserIds: [],
        };

        const { score, reasons } = computeMatchScore(myProfile, theirProfile);

        return { userId: p.user_id, score, reasons };
      });

    const matches = scored.filter((m) => m.score > 0).sort((a, b) =>
      b.score - a.score
    );

    return entraideJson({ matches }, 200, corsHeaders);
  } catch (error) {
    if (!(error instanceof EntraideHttpError)) {
      console.error("Erreur entraide-matches:", error);
    }
    return entraideErrorResponse(error, corsHeaders);
  }
});
