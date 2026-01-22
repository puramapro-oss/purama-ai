import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

    // If user_email provided, look up user_id
    if (!userId && payload.user_email) {
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('email', payload.user_email)
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

    return new Response(
      JSON.stringify({ 
        success: true, 
        notification_id: notification.id,
        message: 'Notification sent successfully' 
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
