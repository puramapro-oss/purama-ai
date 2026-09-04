// GET/POST /functions/v1/entraide-missions — missions collectives (liste, création, actions).
// Actions : /entraide-missions/:id/join|leave|start|complete|cancel (POST).
// Auth requise, transitions via lib pure @purama/entraide (immuable, pas UPDATE partiel).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { json } from "../_shared/response.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import {
  createMissionCollective,
  joinMission,
  leaveMission,
  startMission,
  completeMission,
  cancelMission,
} from "https://esm.sh/@purama/entraide@1.0.0";
import type { MissionCollectiveStatus } from "https://esm.sh/@purama/entraide@1.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const CreateMissionSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000),
  min_participants: z.number().int().min(2),
  max_participants: z.number().int().min(2).nullable().optional(),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Authorization requise" }, { status: 401, headers: corsHeaders });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
      db: { schema: "purama_ai" },
    });

    const supabaseService = createClient(supabaseUrl, supabaseServiceRoleKey, {
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

    const url = new URL(req.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const missionId = pathParts[pathParts.indexOf("entraide-missions") + 1];
    const action = pathParts[pathParts.indexOf("entraide-missions") + 2];

    if (req.method === "GET") {
      await rateLimit(supabase, user.id, "entraide-missions-list", 60);

      const { data, error } = await supabase
        .from("missions_collectives")
        .select(
          `
          *,
          missions_collectives_participants(user_id, joined_at)
        `
        )
        .order("created_at", { ascending: false });

      if (error) throw error;

      return json({ missions: data }, { headers: corsHeaders });
    }

    if (req.method === "POST" && !missionId) {
      await rateLimit(supabase, user.id, "entraide-missions-create", 10);

      const body = await req.json();
      const parsed = CreateMissionSchema.safeParse(body);

      if (!parsed.success) {
        return json(
          { error: "Données invalides", details: parsed.error.errors },
          { status: 400, headers: corsHeaders }
        );
      }

      const id = crypto.randomUUID();
      const result = createMissionCollective({
        id,
        organizerId: user.id,
        minParticipants: parsed.data.min_participants,
        maxParticipants: parsed.data.max_participants ?? null,
      });

      if (!result.ok) {
        return json({ error: result.reason }, { status: 400, headers: corsHeaders });
      }

      const { error: insertError } = await supabaseService.from("missions_collectives").insert({
        id,
        organizer_id: user.id,
        title: parsed.data.title,
        description: parsed.data.description,
        min_participants: parsed.data.min_participants,
        max_participants: parsed.data.max_participants ?? null,
        status: "ouverte",
      });

      if (insertError) throw insertError;

      const { error: participantError } = await supabaseService
        .from("missions_collectives_participants")
        .insert({ mission_id: id, user_id: user.id });

      if (participantError) throw participantError;

      return json({ mission: result.mission }, { headers: corsHeaders });
    }

    if (req.method === "POST" && missionId && action) {
      await rateLimit(supabase, user.id, `entraide-mission-${action}`, 20);

      const { data: missionData, error: fetchError } = await supabaseService
        .from("missions_collectives")
        .select("*")
        .eq("id", missionId)
        .maybeSingle();

      if (fetchError) throw fetchError;
      if (!missionData) {
        return json({ error: "Mission introuvable" }, { status: 404, headers: corsHeaders });
      }

      const { data: participants, error: participantsError } = await supabaseService
        .from("missions_collectives_participants")
        .select("user_id")
        .eq("mission_id", missionId)
        .order("joined_at", { ascending: true });

      if (participantsError) throw participantsError;

      const currentMission = {
        id: missionData.id,
        minParticipants: missionData.min_participants,
        maxParticipants: missionData.max_participants,
        participantIds: participants?.map((p) => p.user_id) ?? [],
        status: missionData.status as MissionCollectiveStatus,
      };

      let result: ReturnType<typeof joinMission>;

      if (action === "join") result = joinMission(currentMission, user.id);
      else if (action === "leave") result = leaveMission(currentMission, user.id);
      else if (action === "start") result = startMission(currentMission);
      else if (action === "complete") result = completeMission(currentMission);
      else if (action === "cancel") result = cancelMission(currentMission);
      else {
        return json({ error: "Action inconnue" }, { status: 400, headers: corsHeaders });
      }

      if (!result.ok) {
        return json({ error: result.reason }, { status: 400, headers: corsHeaders });
      }

      const { error: updateError } = await supabaseService
        .from("missions_collectives")
        .update({ status: result.mission.status, updated_at: new Date().toISOString() })
        .eq("id", missionId);

      if (updateError) throw updateError;

      const { error: deleteError } = await supabaseService
        .from("missions_collectives_participants")
        .delete()
        .eq("mission_id", missionId);

      if (deleteError) throw deleteError;

      if (result.mission.participantIds.length > 0) {
        const { error: insertError } = await supabaseService
          .from("missions_collectives_participants")
          .insert(
            result.mission.participantIds.map((uid: string) => ({
              mission_id: missionId,
              user_id: uid,
            }))
          );

        if (insertError) throw insertError;
      }

      return json({ mission: result.mission }, { headers: corsHeaders });
    }

    return json({ error: "Méthode non supportée" }, { status: 405, headers: corsHeaders });
  } catch (error) {
    console.error("Erreur entraide-missions:", error);
    return json(
      { error: error instanceof Error ? error.message : "Erreur serveur" },
      { status: 500, headers: corsHeaders }
    );
  }
});
