// GET/PUT /functions/v1/entraide-profil — lire/écrire son propre profil entraide.
// Auth requise, RLS garantit user_id = auth.uid().

import { createClient } from "npm:@supabase/supabase-js@2.91.0";
import {
  assertEntraideRateLimit,
  entraideErrorResponse,
  EntraideHttpError,
  entraideJson,
  entraideRouteParts,
  readEntraideJson,
} from "../_shared/entraide-http.ts";
import { z } from "npm:zod@3.25.76";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
};

const ProfilSchema = z.object({
  skills_offered: z.array(z.string()).optional(),
  skills_needed: z.array(z.string()).optional(),
  availability_days: z.array(
    z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
  ).optional(),
  radius_km: z.number().int().min(0).nullable().optional(),
  location_lat: z.number().min(-90).max(90).nullable().optional(),
  location_lng: z.number().min(-180).max(180).nullable().optional(),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (entraideRouteParts(req, "entraide-profil").length !== 0) {
      throw new EntraideHttpError(404, "not_found", "Route introuvable");
    }
    if (req.method !== "GET" && req.method !== "PUT") {
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

    if (req.method === "GET") {
      assertEntraideRateLimit(user.id, "entraide-profil-get", 60);

      // No caller-supplied user ID and no SELECT grant on precise coordinates.
      // The definer RPC reads only auth.uid()'s own row.
      const { data, error } = await supabase.rpc("entraide_own_profile");

      if (error) throw error;

      return entraideJson({ profil: data }, 200, corsHeaders);
    }

    if (req.method === "PUT") {
      assertEntraideRateLimit(user.id, "entraide-profil-put", 20);

      const body = await readEntraideJson(req);
      const parsed = ProfilSchema.safeParse(body);

      if (!parsed.success) {
        return entraideJson(
          {
            error: "invalid_request",
            message: "Données invalides",
            details: parsed.error.errors,
          },
          400,
          corsHeaders,
        );
      }

      const { error } = await supabase
        .from("entraide_profils")
        .upsert(
          {
            user_id: user.id,
            ...parsed.data,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" },
        );

      if (error) throw error;

      return entraideJson({ ok: true }, 200, corsHeaders);
    }

    throw new EntraideHttpError(
      405,
      "method_not_allowed",
      "Méthode non supportée",
    );
  } catch (error) {
    if (!(error instanceof EntraideHttpError)) {
      console.error("Erreur entraide-profil:", error);
    }
    return entraideErrorResponse(error, corsHeaders);
  }
});
