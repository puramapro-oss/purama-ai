// GET/PUT /functions/v1/entraide-profil — lire/écrire son propre profil entraide.
// Auth requise, RLS garantit user_id = auth.uid().

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { json } from "../_shared/response.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { z } from "https://esm.sh/zod@3.23.8";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
};

const ProfilSchema = z.object({
  skills_offered: z.array(z.string()).optional(),
  skills_needed: z.array(z.string()).optional(),
  availability_days: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).optional(),
  radius_km: z.number().int().min(0).nullable().optional(),
  location_lat: z.number().min(-90).max(90).nullable().optional(),
  location_lng: z.number().min(-180).max(180).nullable().optional(),
});

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

    if (req.method === "GET") {
      await rateLimit(supabase, user.id, "entraide-profil-get", 60);

      const { data, error } = await supabase
        .from("entraide_profils")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();

      if (error) throw error;

      return json({ profil: data }, { headers: corsHeaders });
    }

    if (req.method === "PUT") {
      await rateLimit(supabase, user.id, "entraide-profil-put", 20);

      const body = await req.json();
      const parsed = ProfilSchema.safeParse(body);

      if (!parsed.success) {
        return json(
          { error: "Données invalides", details: parsed.error.errors },
          { status: 400, headers: corsHeaders }
        );
      }

      const { error } = await supabase
        .from("entraide_profils")
        .upsert(
          { user_id: user.id, ...parsed.data, updated_at: new Date().toISOString() },
          { onConflict: "user_id" }
        );

      if (error) throw error;

      return json({ ok: true }, { headers: corsHeaders });
    }

    return json({ error: "Méthode non supportée" }, { status: 405, headers: corsHeaders });
  } catch (error) {
    console.error("Erreur entraide-profil:", error);
    return json(
      { error: error instanceof Error ? error.message : "Erreur serveur" },
      { status: 500, headers: corsHeaders }
    );
  }
});
