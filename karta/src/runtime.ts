import type { Server } from "node:http";
import type { ScheduledTask } from "node-cron";
import type { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { config } from "./config.js";
import { isGlobalKillSwitchActive } from "./engine/killswitch.js";
import { redisConnection } from "./queue/redis.js";
import { supabase } from "./db/supabase.js";

let runtimeReady = false;

export function isRuntimeReady(): boolean {
  return runtimeReady;
}

export function setRuntimeReady(ready: boolean): void {
  runtimeReady = ready;
}

/** Vérifie Redis et le schéma KARTA avant d'accepter du trafic ou de planifier des jobs. */
export async function verifyRuntimeDependencies(): Promise<void> {
  const [pong] = await withTimeout(Promise.all([
    redisConnection.ping(),
    isGlobalKillSwitchActive({ fresh: true }),
  ]), config.readinessTimeoutMs, "dépendances KARTA indisponibles");
  if (pong !== "PONG") throw new Error("Redis n'a pas confirmé PONG");
}

/** Valide aussi les tables/colonnes introduites par les migrations KARTA 001 à 006. */
export async function verifyStartupDependencies(): Promise<void> {
  await verifyRuntimeDependencies();
  const requiredSchema: Array<[string, string]> = [
    ["karta_agent_state", "id,user_id,agent_type"],
    ["karta_runs", "id,status,tools_used"],
    ["karta_agent_memory", "id,memory_value"],
    ["karta_pending_actions", "id,status,claimed_at"],
    ["creator_agents", "id,karta_enabled"],
  ];
  for (const [table, columns] of requiredSchema) {
    const { error } = await supabase.from(table).select(columns).limit(1);
    if (error) throw new Error(`Schéma KARTA incomplet (${table}): ${error.message}`);
  }
}

interface RuntimeResources {
  server: Server;
  worker: Pick<Worker, "close">;
  queue: Pick<Queue, "close">;
  redis: Pick<Redis, "quit">;
  schedulers: Array<Pick<ScheduledTask, "stop">>;
}

/** Retire d'abord la readiness, stoppe les producteurs, puis draine dans l'ordre. */
export async function shutdownRuntime(resources: RuntimeResources): Promise<void> {
  setRuntimeReady(false);
  for (const task of resources.schedulers) task.stop();

  const drain = Promise.all([
    closeServer(resources.server),
    resources.worker.close(),
  ]).then(async () => {
    await resources.queue.close();
    await resources.redis.quit();
  });

  await withTimeout(drain, config.shutdownTimeoutMs, "arrêt gracieux KARTA expiré");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}
