import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";

/** Une requête Supabase pendue figeait tout ce qui l'attend — y compris run.finish,
 * recordRunOutcome et loadAgentState dans le chemin du cycle, qui tenaient alors le verrou
 * anti-double jusqu'à son TTL (600s). supabase-js n'installe AUCUNE borne par défaut : ce
 * custom fetch borne TOUTES les requêtes du moteur (journal, états, mémoire, auth admin,
 * tools Supabase) via AbortSignal — annulation réelle du socket, rejet propagé au caller.
 * 30s couvre généreusement une requête REST + marge réseau, même page lente. */
const SUPABASE_TIMEOUT_MS = 30_000;

/** Signature exacte attendue par supabase-js pour `global.fetch`, dérivée de createClient
 * lui-même (aucun mismatch possible si la lib met à jour son type Fetch). */
type SupabaseFetch = NonNullable<NonNullable<Parameters<typeof createClient>[2]>["global"]>["fetch"];

/** Fetch borné passé à supabase-js (`global.fetch`) — exporté pour test uniquement. */
export const boundedFetch: SupabaseFetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS) });

/** Client service_role, schéma purama_ai — utilisé par tout le moteur KARTA (accès serveur uniquement). */
export const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  db: { schema: config.schema },
  auth: { persistSession: false },
  global: { fetch: boundedFetch },
});
