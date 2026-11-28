import { serve } from 'https://deno.land/std@0.190.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.91.0';
import { corsHeaders, SUPPORTED_PLATFORMS } from '../_shared/zernio.ts';
import { resolveSocialSchema } from '../_shared/social-db.ts';
import { handleSocialConfigRequest } from '../_shared/social-management-core.ts';
import { createConfigStore } from '../_shared/social-management-store.ts';
serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { db: { schema: resolveSocialSchema(Deno.env.get('SOCIAL_DB_SCHEMA')) }, auth: { persistSession: false } });
    return await handleSocialConfigRequest(req, {
      corsHeaders, platforms: SUPPORTED_PLATFORMS, store: createConfigStore(supabase),
      authenticate: async token => {
        const { data, error } = await supabase.auth.getUser(token);
        return error ? null : data.user;
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'Configuration sociale indisponible' }), {
      status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
