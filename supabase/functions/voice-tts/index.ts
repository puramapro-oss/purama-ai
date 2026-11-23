// Voice TTS — OpenAI / ElevenLabs text-to-speech
// POST { text, provider?, voice?, speed? }
// Returns: audio/mpeg binary
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.91.0";
import { readBoundedBytes, RequestBodyError } from "../_shared/request-body.ts";
import { cancelResponseQuietly, createRequestDeadline, RequestDeadlineError } from "../_shared/request-deadline.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY") ?? "";
const TTS_TIMEOUT_MS = 30_000;
const MAX_REQUEST_BYTES = 32_768;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const OPENAI_VOICES = new Set(["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // One budget covers authentication, input, generation and the complete audio.
  // These are product resource limits, not a promise of provider latency.
  const endsAt = performance.now() + TTS_TIMEOUT_MS;
  const deadline = createRequestDeadline(TTS_TIMEOUT_MS, req.signal);
  const bodyController = new AbortController();
  const abortBody = () => bodyController.abort();
  req.signal.addEventListener("abort", abortBody, { once: true });
  if (req.signal.aborted) abortBody();
  let phase: "authentication" | "input" | "provider" = "authentication";
  let audioRes: Response | undefined;

  try {
    deadline.check();
    const auth = req.headers.get("Authorization");
    const token = auth && auth.length <= 8192 ? /^Bearer ([^\s]+)$/i.exec(auth)?.[1] : undefined;
    if (!token) return json({ error: "Unauthorized" }, 401);
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return json({ error: "TTS unavailable" }, 503);
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        // The SDK must share the same abort/deadline, including its JSON body.
        fetch: async (input, init) => {
          let response: Response | undefined;
          try {
            const request = new Request(input, init);
            response = await deadline.fetch(new URL(request.url), {
              method: request.method, headers: request.headers, body: request.body,
              redirect: "error", credentials: "omit",
            });
            if (response.redirected) throw new Error("Authentication response unavailable");
            const encoding = response.headers.get("content-encoding");
            const bytes = await deadline.wait(() => readBoundedBytes({
              headers: response!.headers, body: response!.body, signal: bodyController.signal,
            }, { maxBytes: 1_048_576, deadline: endsAt, matchContentLength: !encoding || encoding === "identity" }));
            deadline.check();
            const headers = new Headers(response.headers);
            headers.delete("content-encoding");
            headers.delete("content-length");
            return new Response(bytes.byteLength ? bytes : null, { status: response.status, headers });
          } catch {
            // auth-js logs fetch exceptions internally, before the outer handler
            // can sanitize them. Do not forward the original error or its cause.
            throw new Error("Authentication transport unavailable");
          } finally {
            cancelResponseQuietly(response?.body);
          }
        },
      },
    });
    const { data: userData, error: userErr } = await deadline.wait(() => userClient.auth.getUser(token));
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

    phase = "input";
    const bytes = await deadline.wait(() => readBoundedBytes({
      headers: req.headers, body: req.body, signal: bodyController.signal,
    }, { maxBytes: MAX_REQUEST_BYTES, deadline: endsAt }));
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
    catch { return json({ error: "Invalid TTS request" }, 400); }
    deadline.check();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({ error: "Invalid TTS request" }, 400);
    const body = parsed as Record<string, unknown>;
    if (typeof body.text !== "string") return json({ error: "Invalid TTS text" }, 400);
    const text = body.text.trim();
    if (!text || text.length > 4000) return json({ error: "Invalid TTS text" }, 400);
    const provider = body.provider === undefined ? "openai" : body.provider;
    if (provider !== "openai" && provider !== "elevenlabs") return json({ error: "Invalid TTS provider" }, 400);
    const voice = body.voice === undefined ? (provider === "openai" ? "nova" : "21m00Tcm4TlvDq8ikWAM") : body.voice;
    if (typeof voice !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(voice) ||
      (provider === "openai" && !OPENAI_VOICES.has(voice))) return json({ error: "Invalid TTS voice" }, 400);
    const requestedSpeed = body.speed === undefined ? 1 : body.speed;
    if (typeof requestedSpeed !== "number" || !Number.isFinite(requestedSpeed)) return json({ error: "Invalid TTS speed" }, 400);

    // Never send private text to a different provider than the one selected.
    if ((provider === "elevenlabs" && !ELEVENLABS_API_KEY) || (provider === "openai" && !OPENAI_API_KEY)) {
      return json({ error: "Selected TTS provider unavailable" }, 503);
    }

    phase = "provider";
    deadline.check();
    if (provider === "elevenlabs") {
      const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`);
      url.searchParams.set("output_format", "mp3_44100_128");
      audioRes = await deadline.fetch(url, {
        method: "POST", redirect: "error", credentials: "omit",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: Math.min(Math.max(requestedSpeed, 0.7), 1.2) },
        }),
      });
    } else {
      const speed = Math.min(Math.max(requestedSpeed, 0.25), 4);
      audioRes = await deadline.fetch(new URL("https://api.openai.com/v1/audio/speech"), {
        method: "POST", redirect: "error", credentials: "omit",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "tts-1",
          input: text,
          voice,
          response_format: "mp3",
          speed,
        }),
      });
    }

    deadline.check();
    if (!audioRes.ok || audioRes.redirected || !audioRes.body) return json({ error: "TTS failed" }, 502);
    const mediaType = audioRes.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!mediaType || !["audio/mpeg", "audio/mp3", "application/octet-stream"].includes(mediaType)) {
      return json({ error: "Invalid TTS audio" }, 502);
    }
    const encoding = audioRes.headers.get("content-encoding");
    const buf = await deadline.wait(() => readBoundedBytes({
      headers: audioRes!.headers, body: audioRes!.body, signal: bodyController.signal,
    }, { maxBytes: MAX_AUDIO_BYTES, deadline: endsAt, matchContentLength: !encoding || encoding === "identity" }));
    deadline.check();
    if (!buf.byteLength) return json({ error: "Invalid TTS audio" }, 502);
    return new Response(buf, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (req.signal.aborted) return json({ error: "TTS request cancelled" }, 408);
    if (error instanceof RequestDeadlineError || performance.now() >= endsAt) {
      return json({ error: "TTS deadline exceeded" }, 504);
    }
    if (phase === "input" && error instanceof RequestBodyError) {
      return json({ error: error.status === 413 ? "TTS request too large" : "Invalid TTS request" }, error.status);
    }
    // Fixed diagnostics only: never log or return provider bodies, tokens or text.
    console.error("[voice-tts]", phase, "request_failed");
    return json({ error: "TTS unavailable" }, 502);
  } finally {
    abortBody();
    deadline.close();
    req.signal.removeEventListener("abort", abortBody);
    cancelResponseQuietly(audioRes?.body);
    cancelResponseQuietly(req.body);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
