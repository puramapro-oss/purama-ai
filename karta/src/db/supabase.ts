import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";

/** Client service_role, schéma purama_ai — utilisé par tout le moteur KARTA (accès serveur uniquement). */
export const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  db: { schema: config.schema },
  auth: { persistSession: false },
});
