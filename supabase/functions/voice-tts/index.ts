// Voice TTS — OpenAI / ElevenLabs text-to-speech
// POST { text, provider?, voice?, speed? }
// Returns: audio/mpeg binary
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY") ?? "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const token = auth.replace("Bearer ", "");
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: userData, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

    const body = (await req.json()) as {
      text?: string;
      provider?: "openai" | "elevenlabs";
      voice?: string;
      speed?: number;
    };
    const text = (body.text ?? "").trim().slice(0, 4000);
    if (!text) return json({ error: "text required" }, 400);

    let provider = body.provider ?? "openai";
    if (provider === "elevenlabs" && !ELEVENLABS_API_KEY) provider = "openai";
    if (provider === "openai" && !OPENAI_API_KEY) {
      return json({ error: "No TTS provider configured" }, 500);
    }

    let audioRes: Response;
    if (provider === "elevenlabs") {
      const voiceId = body.voice || "21m00Tcm4TlvDq8ikWAM";
      audioRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      });
    } else {
      const voice = body.voice || "nova";
      const speed = Math.min(Math.max(body.speed ?? 1, 0.25), 4);
      audioRes = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "tts-1",
          input: text,
          voice,
          format: "mp3",
          speed,
        }),
      });
    }

    if (!audioRes.ok) {
      const t = await audioRes.text();
      console.error("[tts]", provider, t);
      return json({ error: "TTS failed", details: t }, 502);
    }

    const buf = await audioRes.arrayBuffer();
    return new Response(buf, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[voice-tts]", msg);
    return json({ error: msg }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
