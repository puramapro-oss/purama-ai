import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET');
const REDIRECT_URI = 'https://agentiapuramafr.lovable.app/oauth/callback';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  try {
    if (action === 'authorize') {
      // Generate OAuth authorization URL
      const provider = url.searchParams.get('provider');
      const state = url.searchParams.get('state');
      const scopes = url.searchParams.get('scopes') || '';

      if (!GOOGLE_CLIENT_ID) {
        return new Response(
          JSON.stringify({ error: 'Google OAuth not configured' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
      authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', scopes);
      authUrl.searchParams.set('state', state || '');
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');

      return new Response(
        JSON.stringify({ authUrl: authUrl.toString() }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'callback') {
      // Handle OAuth callback - exchange code for tokens
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      if (!code) {
        return new Response(
          JSON.stringify({ error: 'Missing authorization code' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        return new Response(
          JSON.stringify({ error: 'Google OAuth not configured' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Exchange code for tokens
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
          redirect_uri: REDIRECT_URI,
        }),
      });

      if (!tokenResponse.ok) {
        const error = await tokenResponse.text();
        console.error('Token exchange failed:', error);
        return new Response(
          JSON.stringify({ error: 'Failed to exchange authorization code' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const tokens = await tokenResponse.json();

      // Parse state to get user info
      let stateData;
      try {
        stateData = JSON.parse(atob(state || ''));
      } catch {
        return new Response(
          JSON.stringify({ error: 'Invalid state parameter' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const { provider, userId } = stateData;

      // Calculate token expiration
      const expiresAt = new Date();
      expiresAt.setSeconds(expiresAt.getSeconds() + (tokens.expires_in || 3600));

      // Store tokens in database
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const supabase = createClient(supabaseUrl, supabaseServiceKey);

      // Upsert connection
      const { error: upsertError } = await supabase
        .from('user_connections')
        .upsert({
          user_id: userId,
          provider: provider,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || null,
          token_expires_at: expiresAt.toISOString(),
        }, {
          onConflict: 'user_id,provider',
        });

      if (upsertError) {
        console.error('Error storing tokens:', upsertError);
        return new Response(
          JSON.stringify({ error: 'Failed to store tokens' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ 
          success: true, 
          provider,
          returnUrl: stateData.returnUrl || '/mes-connexions'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'refresh') {
      // Refresh an expired token
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const body = await req.json();
      const { provider, userId } = body;

      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const supabase = createClient(supabaseUrl, supabaseServiceKey);

      // Get current refresh token
      const { data: connection, error: fetchError } = await supabase
        .from('user_connections')
        .select('refresh_token')
        .eq('user_id', userId)
        .eq('provider', provider)
        .single();

      if (fetchError || !connection?.refresh_token) {
        return new Response(
          JSON.stringify({ error: 'No refresh token available' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Refresh the token
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID!,
          client_secret: GOOGLE_CLIENT_SECRET!,
          refresh_token: connection.refresh_token,
          grant_type: 'refresh_token',
        }),
      });

      if (!tokenResponse.ok) {
        return new Response(
          JSON.stringify({ error: 'Failed to refresh token' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const tokens = await tokenResponse.json();
      const expiresAt = new Date();
      expiresAt.setSeconds(expiresAt.getSeconds() + (tokens.expires_in || 3600));

      // Update tokens
      await supabase
        .from('user_connections')
        .update({
          access_token: tokens.access_token,
          token_expires_at: expiresAt.toISOString(),
        })
        .eq('user_id', userId)
        .eq('provider', provider);

      return new Response(
        JSON.stringify({ success: true, access_token: tokens.access_token }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Invalid action' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('OAuth error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: 'OAuth error', details: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
