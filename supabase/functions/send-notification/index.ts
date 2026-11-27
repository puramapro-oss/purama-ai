import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "resend";
import { readRequestText, RequestBodyError } from "../_shared/request-body.ts";
import { cancelResponseQuietly } from "../_shared/request-deadline.ts";
import { verifyBearerSecret } from "../_shared/webhook-security.ts";
import { resolveNotificationActionUrl } from "../_shared/notification-action-url.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface NotificationPayload {
  user_id?: string;
  user_email?: string;
  agent_slug?: string;
  type: 'task_completed' | 'question' | 'daily_report' | 'alert';
  title: string;
  message: string;
  action_url?: string;
}

const notificationTypes = ['task_completed', 'question', 'daily_report', 'alert'] as const;
const preferenceKeys = ['email_enabled', ...notificationTypes.map(type => `${type}_enabled`)];
const payloadKeys = new Set(['user_id', 'user_email', 'agent_slug', 'type', 'title', 'message', 'action_url']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function email(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254
    && /^[^\s@<>"(),;:\\]+@[^\s@<>"(),;:\\]+\.[^\s@<>"(),;:\\]+$/u.test(value)
    && [...value].every(character => { const code = character.codePointAt(0)!; return code > 31 && code !== 127; });
}

function validText(value: unknown, max: number, multiline = false): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && [...value].every(character => {
      const code = character.codePointAt(0)!;
      return (multiline && [9, 10, 13].includes(code)) || (code > 31 && code !== 127);
    });
}

/** Technical request bounds; no content is reflected in a validation error. */
function validatePayload(value: unknown): NotificationPayload | null {
  if (!record(value) || Object.keys(value).some(key => !payloadKeys.has(key))
    || typeof value.type !== 'string' || !notificationTypes.includes(value.type as NotificationPayload['type'])
    || !validText(value.title, 300) || !validText(value.message, 5000, true)
    || (value.user_id === undefined && value.user_email === undefined)) return null;
  if (value.user_id !== undefined && (typeof value.user_id !== 'string' || !uuid.test(value.user_id))) return null;
  if (value.user_email !== undefined && !email(value.user_email)) return null;
  if (value.agent_slug !== undefined && !validText(value.agent_slug, 100)) return null;
  // Historical callers may explicitly serialize the absent optional link as null.
  const actionUrl = value.action_url === undefined || value.action_url === null
    ? undefined : resolveNotificationActionUrl(value.action_url);
  if (value.action_url !== undefined && value.action_url !== null && actionUrl === null) return null;
  return {
    type: value.type as NotificationPayload['type'], title: value.title, message: value.message,
    ...(typeof value.user_id === 'string' ? { user_id: value.user_id.toLowerCase() } : {}),
    ...(typeof value.user_email === 'string' ? { user_email: value.user_email } : {}),
    ...(typeof value.agent_slug === 'string' ? { agent_slug: value.agent_slug } : {}),
    ...(actionUrl !== undefined && actionUrl !== null ? { action_url: actionUrl } : {}),
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function reply(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: {
    ...corsHeaders, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers,
  } });
}

const typeEmoji: Record<string, string> = {
  task_completed: '✅',
  question: '❓',
  daily_report: '📊',
  alert: '⚠️',
};

const typeLabel: Record<string, string> = {
  task_completed: 'Tâche terminée',
  question: 'Question',
  daily_report: 'Rapport quotidien',
  alert: 'Alerte',
};

const typeColor: Record<string, string> = {
  task_completed: '#22c55e',
  question: '#3b82f6',
  daily_report: '#a855f7',
  alert: '#f97316',
};

function generateEmailHtml(payload: NotificationPayload, actionUrl: string | null): string {
  const emoji = typeEmoji[payload.type];
  const label = typeLabel[payload.type];
  const color = typeColor[payload.type];
  const title = escapeHtml(payload.title);
  const message = escapeHtml(payload.message);
  const agentSlug = payload.agent_slug ? escapeHtml(payload.agent_slug) : null;
  const actionHref = actionUrl ? escapeHtml(actionUrl) : null;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #0a0a0f;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #0a0a0f;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%); border-radius: 16px; border: 1px solid rgba(255,255,255,0.1);">
          <!-- Header -->
          <tr>
            <td style="padding: 32px 32px 24px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td>
                    <span style="font-size: 24px; font-weight: bold; background: linear-gradient(135deg, #00d4ff, #a855f7); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">
                      Agentia
                    </span>
                  </td>
                  <td align="right">
                    <span style="display: inline-block; padding: 6px 12px; background-color: ${color}22; color: ${color}; border-radius: 20px; font-size: 12px; font-weight: 600;">
                      ${emoji} ${label}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 0 32px 32px;">
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 600; color: #ffffff;">
                ${title}
              </h1>
              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #a1a1aa;">
                ${message}
              </p>
              ${agentSlug ? `
              <p style="margin: 0 0 24px; font-size: 14px; color: #71717a;">
                Agent: <span style="color: #00d4ff;">${agentSlug}</span>
              </p>
              ` : ''}
              ${actionHref ? `
              <a href="${actionHref}" style="display: inline-block; padding: 14px 28px; background: linear-gradient(135deg, #00d4ff, #a855f7); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">
                Voir les détails →
              </a>
              ` : ''}
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 32px; border-top: 1px solid rgba(255,255,255,0.1);">
              <p style="margin: 0; font-size: 12px; color: #71717a; text-align: center;">
                Vous recevez cet email car vous avez activé les notifications par email.<br>
                <a href="#" style="color: #a855f7; text-decoration: none;">Gérer vos préférences</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

Deno.serve(async (req) => {
  try {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
    }
    if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405, { Allow: 'POST, OPTIONS' });

    const expectedSecret = Deno.env.get('WEBHOOK_SECRET');
    if (!expectedSecret) return reply({ error: 'Notification service unavailable' }, 503);
    const webhookSecret = req.headers.get('x-webhook-secret');
    if (!verifyBearerSecret(webhookSecret === null ? null : `Bearer ${webhookSecret}`, expectedSecret)) {
      return reply({ error: 'Unauthorized' }, 401);
    }
    if (!/^application\/json(?:\s*;[^\r\n]*)?$/i.test(req.headers.get('content-type') ?? '')) {
      return reply({ error: 'JSON content type required' }, 415);
    }

    let parsed: unknown;
    try { parsed = JSON.parse(await readRequestText(req, { maxBytes: 32_768, timeoutMs: 5_000 })); }
    catch (error) {
      return reply({ error: 'Invalid notification request' }, error instanceof RequestBodyError ? error.status : 400);
    }
    const payload = validatePayload(parsed);
    if (!payload) return reply({ error: 'Invalid notification request' }, 400);
    if (req.signal.aborted) return reply({ error: 'Notification request interrupted' }, 408);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseServiceKey) return reply({ error: 'Notification service unavailable' }, 503);
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      db: { schema: 'purama_ai', retry: false },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // profiles is a routing hint, not an authority for a confirmed email address.
    // A user can edit that profile: never send to its email without Auth proof.
    let profile: Record<string, unknown>;
    try {
      const lookup = supabase.from('profiles').select('user_id,email');
      const result = await (payload.user_id
        ? lookup.eq('user_id', payload.user_id)
        : lookup.eq('email', payload.user_email!)).maybeSingle();
      if (req.signal.aborted) return reply({ error: 'Notification request interrupted' }, 408);
      if (result.error) return reply({ error: 'Recipient unavailable' }, 503);
      if (result.data === null) return reply({ error: 'Recipient not found' }, 404);
      if (!record(result.data) || typeof result.data.user_id !== 'string' || !uuid.test(result.data.user_id)
        || (result.data.email !== null && !email(result.data.email))) return reply({ error: 'Recipient unavailable' }, 503);
      profile = result.data;
      const profileId = (profile.user_id as string).toLowerCase();
      if (payload.user_id && profileId !== payload.user_id) return reply({ error: 'Recipient unavailable' }, 503);
      if (!payload.user_id && (typeof profile.email !== 'string'
        || profile.email.toLowerCase() !== payload.user_email!.toLowerCase())) return reply({ error: 'Recipient unavailable' }, 503);
    } catch { return reply({ error: 'Recipient unavailable' }, 503); }
    const userId = (profile.user_id as string).toLowerCase();

    let preferences: Record<string, unknown> | null;
    try {
      const result = await supabase.from('notification_preferences')
        .select(`user_id,${preferenceKeys.join(',')}`).eq('user_id', userId).maybeSingle();
      if (req.signal.aborted) return reply({ error: 'Notification request interrupted' }, 408);
      if (result.error || (result.data !== null && (!record(result.data)
        || typeof result.data.user_id !== 'string' || result.data.user_id.toLowerCase() !== userId
        || preferenceKeys.some(key => result.data[key] !== null && typeof result.data[key] !== 'boolean')))) {
        return reply({ error: 'Notification preferences unavailable' }, 503);
      }
      preferences = result.data;
    } catch { return reply({ error: 'Notification preferences unavailable' }, 503); }
    // NULL flags and a confirmed absent row retain the original SQL defaults.
    if (preferences?.[`${payload.type}_enabled`] === false) {
      return reply({ success: true, message: 'Notification skipped - user has disabled this type', notification_type: payload.type }, 200);
    }

    const emailEnabled = preferences?.email_enabled !== false;
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    let recipientEmail: string | null = null;
    const wantsEmail = emailEnabled && profile.email !== null && Boolean(resendApiKey);
    if (wantsEmail || payload.user_email !== undefined) {
      try {
        const identity = await supabase.auth.admin.getUserById(userId);
        if (req.signal.aborted) return reply({ error: 'Notification request interrupted' }, 408);
        const user = identity.data?.user;
        if (identity.error || !user || typeof user.id !== 'string' || user.id.toLowerCase() !== userId
          || (user.email !== undefined && user.email !== null && !email(user.email))) {
          return reply({ error: 'Recipient unavailable' }, 503);
        }
        if (payload.user_email !== undefined && (!email(user.email)
          || user.email.toLowerCase() !== payload.user_email.toLowerCase())) {
          return reply({ error: 'Recipient does not match' }, 400);
        }
        const confirmedAt = typeof user.email_confirmed_at === 'string' ? Date.parse(user.email_confirmed_at) : NaN;
        if (wantsEmail && email(user.email) && Number.isFinite(confirmedAt) && confirmedAt <= Date.now()) recipientEmail = user.email;
      } catch { return reply({ error: 'Recipient unavailable' }, 503); }
    }

    // Store the same validated navigation reference used by the email and UI.
    const fullActionUrl = payload.action_url ? new URL(payload.action_url, 'https://purama-ai.purama.dev').href : null;
    if (req.signal.aborted) return reply({ error: 'Notification request interrupted' }, 408);
    let notificationId: string;
    try {
      const result = await supabase.from('notifications').insert({
        user_id: userId, agent_slug: payload.agent_slug ?? null, type: payload.type,
        title: payload.title, message: payload.message, action_url: payload.action_url ?? null, read: false,
      }).select('id').single();
      if (result.error || !record(result.data) || typeof result.data.id !== 'string' || !uuid.test(result.data.id)) {
        return reply({ error: 'Notification creation could not be confirmed' }, 500);
      }
      notificationId = result.data.id;
    } catch { return reply({ error: 'Notification creation could not be confirmed' }, 500); }

    // A provider failure cannot roll back the already acknowledged in-app row.
    // Do not retry either effect and do not claim that provider acceptance proves delivery.
    let emailSent = false;
    if (recipientEmail && resendApiKey && !req.signal.aborted) {
      try {
        const resend = new Resend(resendApiKey);
        const result = await resend.emails.send({
          from: 'Agentia <notifications@resend.dev>', to: [recipientEmail],
          subject: `${typeEmoji[payload.type]} ${payload.title}`, html: generateEmailHtml(payload, fullActionUrl),
        });
        emailSent = !result.error && typeof result.data?.id === 'string' && result.data.id.trim().length > 0;
      } catch { /* Keep the single successful in-app effect; never log provider/user data. */ }
    }
    return reply({
      success: true, notification_id: notificationId, email_sent: emailSent,
      message: emailSent ? 'Notification created and email accepted' : 'Notification created (email acceptance not confirmed or disabled)',
    }, 201);
  } catch {
    return reply({ error: 'Notification service unavailable' }, 503);
  } finally {
    cancelResponseQuietly(req.body);
  }
});
