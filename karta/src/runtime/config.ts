export interface RuntimeConfig {
  supabaseUrl: string; supabaseServiceRoleKey: string; adminToken: string;
  redisUrl: string; port: number; mockClaude: boolean; anthropicApiKey: string;
}

/** Validate before importing modules that construct clients or register work. */
export function validateRuntimeConfig(config: RuntimeConfig): void {
  try {
    if (!config.supabaseServiceRoleKey.trim() || !config.adminToken.trim()) throw new Error();
    if (!config.mockClaude && !config.anthropicApiKey.trim()) throw new Error();
    if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error();
    const database = new URL(config.supabaseUrl);
    const redis = new URL(config.redisUrl);
    if (!["http:", "https:"].includes(database.protocol) || !database.hostname || database.username || database.password) throw new Error();
    if (!["redis:", "rediss:"].includes(redis.protocol) || !redis.hostname) throw new Error();
  } catch { throw new Error("Configuration KARTA incomplète ou invalide"); }
}
