import { createClient } from 'npm:@supabase/supabase-js@2.91.0';
import { createSupabaseEntraidePorts, type EntraideDatabase } from './entraide-supabase.ts';

function configuration() {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) throw new Error('missing_configuration');
  return { url, anonKey, serviceKey };
}

export const entraidePorts = createSupabaseEntraidePorts({
  authenticatedClient(header) {
    const { url, anonKey } = configuration();
    return createClient<EntraideDatabase, 'purama_ai'>(url, anonKey, {
      global: { headers: { Authorization: header } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      db: { schema: 'purama_ai' },
    });
  },
  serviceClient() {
    const { url, serviceKey } = configuration();
    return createClient<EntraideDatabase, 'purama_ai'>(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      db: { schema: 'purama_ai' },
    });
  },
});
