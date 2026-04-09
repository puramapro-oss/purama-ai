// Shared push notification sender — used by all Purama agents (compta, email, …)
// POST { user_id, agent_type, title, body, action_type?, action_payload?, action_url?, priority?, channels? }
// 1. Insert into agent_notifications
// 2. For each active push subscription of the user, send a Web Push via VAPID
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "https://esm.sh/web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT =
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:matiss.frasne@gmail.com";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  } catch (e) {
    console.error("[push] VAPID setup failed", e);
  }
}

interface PushBody {
  user_id: string;
  agent_type: string;
  title: string;
  body: string;
  action_type?: string;
  action_payload?: Record<string, unknown>;
  action_url?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  channels?: string[];
  expires_in_days?: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    // Service-role required (this endpoint is called by n8n & other agents)
    const auth = req.headers.get("Authorization");
    if (
      !auth ||
      !auth.includes(SUPABASE_SERVICE_ROLE_KEY)
    ) {
      return json({ error: "Forbidden — service role required" }, 403);
    }

    const body = (await req.json()) as PushBody;
    if (!body.user_id || !body.title || !body.body || !body.agent_type) {
      return json({ error: "Missing required fields" }, 400);
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      db: { schema: "purama_ai" },
    });

    const channels = body.channels ?? ["push", "in_app"];
    const expiresAt = body.expires_in_days
      ? new Date(Date.now() + body.expires_in_days * 86400 * 1000).toISOString()
      : null;

    // 1. Insert notification row
    const { data: notif, error: insErr } = await admin
      .from("agent_notifications")
      .insert({
        user_id: body.user_id,
        agent_type: body.agent_type,
        title: body.title,
        body: body.body,
        action_type: body.action_type ?? null,
        action_payload: body.action_payload ?? null,
        action_url: body.action_url ?? null,
        priority: body.priority ?? "normal",
        channels,
        expires_at: expiresAt,
      })
      .select()
      .single();
    if (insErr) throw insErr;

    let pushSent = 0;
    let pushFailed = 0;

    // 2. Send Web Push if requested
    if (channels.includes("push") && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
      const { data: subs, error: subsErr } = await admin
        .from("push_subscriptions")
        .select("id, subscription, endpoint")
        .eq("user_id", body.user_id)
        .eq("is_active", true);
      if (subsErr) console.error("[push] fetch subs", subsErr);

      const payload = JSON.stringify({
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
          await webpush.sendNotification(sub.subscription as unknown as Parameters<typeof webpush.sendNotification>[0], payload);
          pushSent++;
        } catch (e) {
          pushFailed++;
          const status = (e as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) {
            // Subscription is gone — deactivate
            await admin
              .from("push_subscriptions")
              .update({ is_active: false })
              .eq("id", sub.id);
          } else {
            console.error("[push] send failed", e);
          }
        }
      }

      if (pushSent > 0) {
        await admin
          .from("agent_notifications")
          .update({ sent_push: true })
          .eq("id", notif.id);
      }
    }

    return json({
      ok: true,
      notification_id: notif.id,
      push_sent: pushSent,
      push_failed: pushFailed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[agent-push-send]", msg);
    return json({ error: msg }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
