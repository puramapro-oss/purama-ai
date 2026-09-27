// Shared push notification sender — internal service endpoint.
// Authentication uses a dedicated KARTA_EDGE_TOKEN, never the Supabase service-role key.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "https://esm.sh/web-push@3.6.7";

const ALLOWED_ORIGIN = Deno.env.get("PUBLIC_APP_ORIGIN") ?? "https://purama-ai.purama.dev";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const KARTA_EDGE_TOKEN = Deno.env.get("KARTA_EDGE_TOKEN") ?? "";
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:security@purama.dev";
const MAX_BODY_BYTES = 65_536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_TYPE = /^(?:[a-z0-9][a-z0-9-]{0,99}|custom:[0-9a-f-]{36})$/i;
const CHANNELS = new Set(["push", "email", "in_app"]);
const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  } catch {
    console.error("[push] VAPID setup failed");
  }
}

interface PushBody {
  user_id: string;
  agent_type: string;
  title: string;
  body: string;
  action_type?: string;
  action_payload?: Record<string, unknown>;
  action_url?: string | null;
  priority?: "low" | "normal" | "high" | "urgent";
  channels?: string[];
  expires_in_days?: number;
  operation_id?: string | null;
}

function responseHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("origin");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Vary": "Origin",
  };
  if (origin === ALLOWED_ORIGIN) headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
  return headers;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function isAuthorized(req: Request): Promise<boolean> {
  if (!KARTA_EDGE_TOKEN || KARTA_EDGE_TOKEN.length < 32) return false;
  const actual = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${KARTA_EDGE_TOKEN}`;
  const [a, b] = await Promise.all([sha256(actual), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function readObject(req: Request): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new RequestError(413, "Requête trop volumineuse");

  const reader = req.body?.getReader();
  if (!reader) throw new RequestError(400, "Corps requis");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RequestError(413, "Requête trop volumineuse");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }

  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new RequestError(400, "JSON invalide");
  }
}

function validateBody(raw: Record<string, unknown>): PushBody {
  const stringField = (name: string, max: number): string => {
    const value = raw[name];
    if (typeof value !== "string" || !value.trim() || value.length > max) throw new RequestError(400, `${name} invalide`);
    return value;
  };

  const user_id = stringField("user_id", 64);
  const agent_type = stringField("agent_type", 120);
  const title = stringField("title", 200).replace(/[\r\n\u0000]/g, " ");
  const body = stringField("body", 10_000).replace(/\u0000/g, "");
  if (!UUID.test(user_id)) throw new RequestError(400, "user_id invalide");
  if (!AGENT_TYPE.test(agent_type)) throw new RequestError(400, "agent_type invalide");

  const priority = raw.priority === undefined ? "normal" : raw.priority;
  if (typeof priority !== "string" || !PRIORITIES.has(priority)) throw new RequestError(400, "priority invalide");

  const channelsRaw = raw.channels === undefined ? ["push", "in_app"] : raw.channels;
  if (!Array.isArray(channelsRaw) || channelsRaw.length > 3 || channelsRaw.some(v => typeof v !== "string" || !CHANNELS.has(v))) {
    throw new RequestError(400, "channels invalide");
  }
  const channels = [...new Set(channelsRaw as string[])];

  let action_url: string | null | undefined;
  if (raw.action_url !== undefined && raw.action_url !== null) {
    if (typeof raw.action_url !== "string" || raw.action_url.length > 500 || !/^\/[A-Za-z0-9/_?&=.%#-]*$/.test(raw.action_url)) {
      throw new RequestError(400, "action_url invalide");
    }
    action_url = raw.action_url;
  }

  let action_type: string | undefined;
  if (raw.action_type !== undefined) {
    if (typeof raw.action_type !== "string" || !/^[a-z0-9_-]{1,80}$/i.test(raw.action_type)) throw new RequestError(400, "action_type invalide");
    action_type = raw.action_type;
  }

  let action_payload: Record<string, unknown> | undefined;
  if (raw.action_payload !== undefined) {
    if (!raw.action_payload || typeof raw.action_payload !== "object" || Array.isArray(raw.action_payload)) throw new RequestError(400, "action_payload invalide");
    if (JSON.stringify(raw.action_payload).length > 16_384) throw new RequestError(400, "action_payload trop volumineux");
    action_payload = raw.action_payload as Record<string, unknown>;
  }

  let expires_in_days: number | undefined;
  if (raw.expires_in_days !== undefined) {
    if (!Number.isSafeInteger(raw.expires_in_days) || (raw.expires_in_days as number) < 1 || (raw.expires_in_days as number) > 365) {
      throw new RequestError(400, "expires_in_days invalide");
    }
    expires_in_days = raw.expires_in_days as number;
  }

  let operation_id: string | null | undefined;
  if (raw.operation_id !== undefined && raw.operation_id !== null) {
    if (typeof raw.operation_id !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(raw.operation_id)) throw new RequestError(400, "operation_id invalide");
    operation_id = raw.operation_id;
  }

  return {
    user_id, agent_type, title, body, priority: priority as PushBody["priority"], channels,
    action_url, action_type, action_payload, expires_in_days, operation_id,
  };
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    if (req.headers.get("origin") !== ALLOWED_ORIGIN) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        ...responseHeaders(req),
        "Access-Control-Allow-Headers": "authorization, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !(await isAuthorized(req))) {
    return json(req, { error: "Forbidden" }, 403);
  }

  try {
    const body = validateBody(await readObject(req));
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { db: { schema: "purama_ai" } });
    const expiresAt = body.expires_in_days
      ? new Date(Date.now() + body.expires_in_days * 86_400_000).toISOString()
      : null;

    const payload = {
      ...(body.action_payload ?? {}),
      ...(body.operation_id ? { operation_id: body.operation_id } : {}),
    };

    const { data: notif, error: insErr } = await admin
      .from("agent_notifications")
      .insert({
        user_id: body.user_id,
        agent_type: body.agent_type,
        title: body.title,
        body: body.body,
        action_type: body.action_type ?? null,
        action_payload: payload,
        action_url: body.action_url ?? null,
        priority: body.priority ?? "normal",
        channels: body.channels,
        expires_at: expiresAt,
      })
      .select("id")
      .single();
    if (insErr || !notif?.id) throw new Error("notification insert failed");

    let pushSent = 0;
    let pushFailed = 0;

    if (body.channels?.includes("push") && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
      const { data: subs, error: subsErr } = await admin
        .from("push_subscriptions")
        .select("id, subscription")
        .eq("user_id", body.user_id)
        .eq("is_active", true);
      if (subsErr) throw new Error("subscription lookup failed");

      const pushPayload = JSON.stringify({
        title: body.title,
        body: body.body,
        action_type: body.action_type,
        action_payload: body.action_payload,
        action_url: body.action_url,
        priority: body.priority ?? "normal",
        tag: `${body.agent_type}-${body.action_type ?? "info"}`,
      });

      for (const sub of subs ?? []) {
        try {
          await webpush.sendNotification(sub.subscription as unknown as Parameters<typeof webpush.sendNotification>[0], pushPayload);
          pushSent++;
        } catch (error) {
          pushFailed++;
          const status = (error as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) {
            await admin.from("push_subscriptions").update({ is_active: false }).eq("id", sub.id);
          } else {
            console.error("[push] send failed");
          }
        }
      }

      if (pushSent > 0) {
        await admin.from("agent_notifications").update({ sent_push: true }).eq("id", notif.id);
      }
    }

    return json(req, { ok: true, notification_id: notif.id, push_sent: pushSent, push_failed: pushFailed });
  } catch (error) {
    if (error instanceof RequestError) return json(req, { error: error.message }, error.status);
    console.error("[agent-push-send] internal failure");
    return json(req, { error: "Internal error" }, 500);
  }
});

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(req) });
}
