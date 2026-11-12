import { supabase } from "../db/supabase.js";
import { redisConnection } from "../queue/redis.js";

/** Read-only, fresh schema/dependency checks. No scheduler, claim or provider call. */
export async function probeRuntime(signal: AbortSignal): Promise<{ globalKillSwitch: boolean }> {
  try {
    if (signal.aborted) throw new Error();
    // A disconnected client must not accumulate health commands in its offline queue.
    if (redisConnection.status !== "ready") {
      await new Promise<void>((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const fail = () => { cleanup(); reject(new Error()); };
        const cleanup = () => {
          redisConnection.off("ready", done); redisConnection.off("end", fail);
          signal.removeEventListener("abort", fail);
        };
        if (signal.aborted || redisConnection.status === "end") { fail(); return; }
        redisConnection.once("ready", done); redisConnection.once("end", fail);
        signal.addEventListener("abort", fail, { once: true });
      });
    }
    if (signal.aborted) throw new Error();
    const [outbox, global, runs, actions, pong] = await Promise.all([
      supabase.rpc("karta_approval_outbox_health").abortSignal(signal),
      supabase.from("karta_global_state").select("kill_switch").eq("id", "global").abortSignal(signal).single(),
      supabase.from("karta_runs").select("execution_fingerprint,model_usage").limit(0).abortSignal(signal),
      supabase.from("karta_pending_actions").select("execution_trigger").limit(0).abortSignal(signal),
      redisConnection.ping(),
    ]);
    if (signal.aborted || outbox.error || global.error || runs.error || actions.error
      || outbox.data?.protocol !== 1 || outbox.data?.ready !== true
      || typeof global.data?.kill_switch !== "boolean" || !Array.isArray(runs.data)
      || !Array.isArray(actions.data) || pong !== "PONG") throw new Error();
    return { globalKillSwitch: global.data.kill_switch };
  } catch { throw new Error("Dépendances KARTA indisponibles ou incompatibles"); }
}
