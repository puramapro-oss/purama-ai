import { supabase } from "../db/supabase.js";

let cachedUntil = 0;
let cachedValue = false;
const CACHE_MS = 5_000; // cache destiné aux lectures d'affichage, jamais à autoriser une action

/** La boucle et les approbations exigent une lecture fraîche avant chaque nouvelle action. */
export async function isGlobalKillSwitchActive(options: { fresh?: boolean } = {}): Promise<boolean> {
  if (!options.fresh && Date.now() < cachedUntil) return cachedValue;

  const { data, error } = await supabase.from("karta_global_state").select("kill_switch").eq("id", "global").single();

  if (error) throw new Error(`isGlobalKillSwitchActive: ${error.message}`);
  if (!data || typeof data.kill_switch !== "boolean") {
    throw new Error("isGlobalKillSwitchActive: état global invalide — exécution bloquée");
  }

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
