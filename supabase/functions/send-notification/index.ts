import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "resend";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
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

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${payload.title}</title>
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
                ${payload.title}
              </h1>
              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #a1a1aa;">
                ${payload.message}
              </p>
              ${payload.agent_slug ? `
              <p style="margin: 0 0 24px; font-size: 14px; color: #71717a;">
                Agent: <span style="color: #00d4ff;">${payload.agent_slug}</span>
              </p>
              ` : ''}
              ${actionUrl ? `
              <a href="${actionUrl}" style="display: inline-block; padding: 14px 28px; background: linear-gradient(135deg, #00d4ff, #a855f7); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">
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
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify webhook secret
    const webhookSecret = req.headers.get('x-webhook-secret');
    const expectedSecret = Deno.env.get('WEBHOOK_SECRET');
    
    if (!expectedSecret) {
      console.error('WEBHOOK_SECRET not configured');
      return new Response(
        JSON.stringify({ error: 'Server configuration error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (webhookSecret !== expectedSecret) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized - Invalid webhook secret' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Parse request body
    const payload: NotificationPayload = await req.json();

    // Validate required fields
    if (!payload.type || !payload.title || !payload.message) {
      return new Response(
        JSON.stringify({ 
          error: 'Missing required fields', 
          required: ['type', 'title', 'message'],
          received: payload 
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate notification type
    const validTypes = ['task_completed', 'question', 'daily_report', 'alert'];
    if (!validTypes.includes(payload.type)) {
      return new Response(
        JSON.stringify({ 
          error: 'Invalid notification type', 
          valid_types: validTypes 
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Must have either user_id or user_email
    if (!payload.user_id && !payload.user_email) {
      return new Response(
        JSON.stringify({ 
          error: 'Must provide either user_id or user_email' 
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create Supabase client with service role
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let userId = payload.user_id;
    let userEmail = payload.user_email;

    // If user_email provided, look up user_id
    if (!userId && userEmail) {
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('user_id, email')
        .eq('email', userEmail)
        .maybeSingle();

      if (profileError) {
        console.error('Error looking up user:', profileError);
        return new Response(
          JSON.stringify({ error: 'Error looking up user' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (!profile) {
        return new Response(
          JSON.stringify({ error: 'User not found with provided email' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      userId = profile.user_id;
    }

    // If user_id provided but no email, look up email
    if (userId && !userEmail) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('email')
        .eq('user_id', userId)
        .maybeSingle();

      if (profile?.email) {
        userEmail = profile.email;
      }
    }

    // Check user's notification preferences
    const { data: preferences } = await supabase
      .from('notification_preferences')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    // Check if this notification type is enabled (default to true if no preferences)
    const typePreferenceMap: Record<string, string> = {
      'task_completed': 'task_completed_enabled',
      'question': 'question_enabled',
      'daily_report': 'daily_report_enabled',
      'alert': 'alert_enabled',
    };

    const preferenceKey = typePreferenceMap[payload.type];
    const isEnabled = preferences ? preferences[preferenceKey] !== false : true;

    if (!isEnabled) {
      return new Response(
        JSON.stringify({ 
          success: true, 
          message: 'Notification skipped - user has disabled this type',
          notification_type: payload.type 
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Build full action URL
    const baseUrl = 'https://agentiapuramafr.lovable.app';
    const fullActionUrl = payload.action_url 
      ? (payload.action_url.startsWith('http') ? payload.action_url : `${baseUrl}${payload.action_url}`)
      : null;

    // Insert notification
    const { data: notification, error: insertError } = await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        agent_slug: payload.agent_slug || null,
        type: payload.type,
        title: payload.title,
        message: payload.message,
        action_url: payload.action_url || null,
        read: false,
      })
      .select()
      .single();

    if (insertError) {
      console.error('Error inserting notification:', insertError);
      return new Response(
        JSON.stringify({ error: 'Failed to create notification', details: insertError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Notification created:', notification.id);

    // Send email if enabled
    let emailSent = false;
    const emailEnabled = preferences ? preferences.email_enabled !== false : true;
    const resendApiKey = Deno.env.get('RESEND_API_KEY');

    if (emailEnabled && userEmail && resendApiKey) {
      try {
        const resend = new Resend(resendApiKey);
        
        const emailHtml = generateEmailHtml(payload, fullActionUrl);
        
        const { error: emailError } = await resend.emails.send({
          from: 'Agentia <notifications@resend.dev>',
          to: [userEmail],
          subject: `${typeEmoji[payload.type]} ${payload.title}`,
          html: emailHtml,
        });

        if (emailError) {
          console.error('Error sending email:', emailError);
        } else {
          console.log('Email sent to:', userEmail);
          emailSent = true;
        }
      } catch (emailErr) {
        console.error('Email sending failed:', emailErr);
      }
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        notification_id: notification.id,
        email_sent: emailSent,
        message: emailSent 
          ? 'Notification sent and email delivered' 
          : 'Notification sent (email skipped or failed)'
      }),
      { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error processing request:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: 'Internal server error', details: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
