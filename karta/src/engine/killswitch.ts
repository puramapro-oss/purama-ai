import { supabase } from "../db/supabase.js";

let cachedUntil = 0;
let cachedValue = false;
const CACHE_MS = 5_000; // évite de spammer la DB à chaque cycle d'agent, tout en restant quasi-instantané

/** Software dispatch gate, not a physical emergency stop. Action boundaries must
 * bypass the cache so another worker's stop is not hidden for five seconds. */
export async function isGlobalKillSwitchActive(forceRefresh = false): Promise<boolean> {
  if (!forceRefresh && Date.now() < cachedUntil) return cachedValue;

  const { data, error } = await supabase.from("karta_global_state").select("kill_switch").eq("id", "global").single();

  if (error) throw new Error(`isGlobalKillSwitchActive: ${error.message}`);

  cachedValue = data.kill_switch;
  cachedUntil = Date.now() + CACHE_MS;
  return cachedValue;
}

export async function setGlobalKillSwitch(active: boolean, updatedBy?: string): Promise<void> {
  const { error } = await supabase
    .from("karta_global_state")
    .update({ kill_switch: active, updated_at: new Date().toISOString(), updated_by: updatedBy ?? null })
    .eq("id", "global");

  if (error) throw new Error(`setGlobalKillSwitch: ${error.message}`);

  cachedUntil = 0; // invalide le cache immédiatement
}
