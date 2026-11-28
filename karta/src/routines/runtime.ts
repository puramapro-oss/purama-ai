import type { PhoneConfig } from "./phone.js";

export interface RoutineRuntimeConfig {
  enabled: boolean;
  phone: PhoneConfig;
  pushEnabled: boolean;
  commandSecret: string;
}

/** Server-owned opt-ins; no provider is activated by installing the migration. */
export function routineRuntimeConfig(): RoutineRuntimeConfig {
  return {
    enabled: process.env.IAO_ROUTINES_ENABLED === "true",
    phone: {
      enabled: process.env.IAO_CALLS_ENABLED === "true",
      apiKey: process.env.BLAND_API_KEY ?? "",
      agentId: process.env.BLAND_AGENT_ID ?? "",
      webhookSecret: process.env.BLAND_WEBHOOK_SECRET ?? "",
      webhookUrl: process.env.IAO_PHONE_WEBHOOK_URL ?? "",
    },
    pushEnabled: process.env.IAO_ROUTINES_PUSH_ENABLED === "true",
    commandSecret: process.env.IAO_PHONE_COMMAND_SECRET ?? "",
  };
}

export function phoneConfigured(config: RoutineRuntimeConfig): boolean {
  const phone = config.phone;
  try {
    const url = new URL(phone.webhookUrl);
    return config.enabled && phone.enabled && !!phone.apiKey.trim() && !!phone.webhookSecret.trim()
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(phone.agentId)
      && url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch { return false; }
}
