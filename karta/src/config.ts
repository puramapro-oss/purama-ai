import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value.trim() === "") {
    throw new Error(`Variable d'environnement manquante: ${name}`);
  }
  return value;
}

export function parseBoundedInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} doit etre un entier entre ${min} et ${max}`);
  }
  return value;
}

const legacyMockEnabled = (process.env.KARTA_MOCK_CLAUDE ?? "true") !== "false";
const aiProvider = process.env.AI_PROVIDER ?? (legacyMockEnabled ? "mock" : "anthropic");
const allowedProviders = ["mock", "anthropic", "openai-compatible", "ollama"] as const;
if (!allowedProviders.includes(aiProvider as typeof allowedProviders[number])) {
  throw new Error(`AI_PROVIDER non supporte: ${aiProvider}`);
}

const fallbackProvider = process.env.AI_FALLBACK_PROVIDER ?? "none";
if (!["none", ...allowedProviders].includes(fallbackProvider as "none" | typeof allowedProviders[number])) {
  throw new Error(`AI_FALLBACK_PROVIDER non supporte: ${fallbackProvider}`);
}
if (fallbackProvider !== "none" && fallbackProvider === aiProvider) {
  throw new Error("AI_FALLBACK_PROVIDER doit etre different de AI_PROVIDER");
}

const runtimeEnvironment = process.env.NODE_ENV ?? "production";
const mockProviderAllowed = runtimeEnvironment === "test" || runtimeEnvironment === "development";
if (!mockProviderAllowed && (aiProvider === "mock" || fallbackProvider === "mock")) {
  throw new Error("Le fournisseur mock est reserve aux environnements test et development");
}

export const config = {
  supabaseUrl: required("SUPABASE_URL", "https://auth.purama.dev"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY", ""),
  schema: "purama_ai" as const,

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicModelMain: required("ANTHROPIC_MODEL_MAIN", "claude-sonnet-4-6"),
  anthropicModelFast: required("ANTHROPIC_MODEL_FAST", "claude-haiku-4-5-20251001"),
  // Compatibilité historique; le garde-fou ci-dessus interdit ce mode hors test/development.
  mockClaude: aiProvider === "mock",

  aiProvider: aiProvider as typeof allowedProviders[number],
  aiFallbackProvider: fallbackProvider as "none" | typeof allowedProviders[number],
  aiBaseUrl: process.env.AI_BASE_URL ?? "",
  aiApiKey: process.env.AI_API_KEY ?? "",
  aiModelMain: process.env.AI_MODEL_MAIN ?? "",
  aiModelFast: process.env.AI_MODEL_FAST ?? "",
  aiTimeoutMs: parseBoundedInteger("AI_TIMEOUT_MS", process.env.AI_TIMEOUT_MS, 60_000, 1_000, 120_000),
  aiMaxRetries: parseBoundedInteger("AI_MAX_RETRIES", process.env.AI_MAX_RETRIES, 1, 0, 2),
  workerConcurrency: parseBoundedInteger("KARTA_WORKER_CONCURRENCY", process.env.KARTA_WORKER_CONCURRENCY, 5, 1, 8),
  providerTimeoutMs: parseBoundedInteger(
    "KARTA_PROVIDER_TIMEOUT_MS", process.env.KARTA_PROVIDER_TIMEOUT_MS, 15_000, 1_000, 60_000
  ),
  notificationTimeoutMs: parseBoundedInteger(
    "KARTA_NOTIFICATION_TIMEOUT_MS", process.env.KARTA_NOTIFICATION_TIMEOUT_MS, 10_000, 1_000, 30_000
  ),
  approvalExecutingTimeoutMinutes: parseBoundedInteger(
    "KARTA_APPROVAL_EXECUTING_TIMEOUT_MINUTES", process.env.KARTA_APPROVAL_EXECUTING_TIMEOUT_MINUTES, 15, 5, 1_440
  ),
  approvalReconcileCron: process.env.KARTA_APPROVAL_RECONCILE_CRON ?? "*/5 * * * *",
  opsAlertUrl: process.env.KARTA_OPS_ALERT_URL ?? "",
  opsAlertTimeoutMs: parseBoundedInteger(
    "KARTA_OPS_ALERT_TIMEOUT_MS", process.env.KARTA_OPS_ALERT_TIMEOUT_MS, 5_000, 1_000, 15_000
  ),
  shutdownTimeoutMs: parseBoundedInteger(
    "KARTA_SHUTDOWN_TIMEOUT_MS", process.env.KARTA_SHUTDOWN_TIMEOUT_MS, 30_000, 5_000, 120_000
  ),
  readinessTimeoutMs: parseBoundedInteger(
    "KARTA_READINESS_TIMEOUT_MS", process.env.KARTA_READINESS_TIMEOUT_MS, 5_000, 500, 30_000
  ),

  redisUrl: required("REDIS_URL", "redis://127.0.0.1:6379"),

  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",

  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  // Chiffrement au repos des tokens Gmail (brief §Phase 3 "tokens chiffrés AES-256") — optionnel au
  // démarrage (0 connexion Gmail réelle actuellement) mais requis dès le 1er appel réel à Gmail.
  gmailTokenEncryptionKey: process.env.GMAIL_TOKEN_ENCRYPTION_KEY ?? "",

  resendApiKey: process.env.RESEND_API_KEY ?? "",
  resendFromEmail: process.env.RESEND_FROM_EMAIL ?? "hello@purama-ai.purama.dev",

  tavilyApiKey: process.env.TAVILY_API_KEY ?? "",
  zernioApiKey: process.env.ZERNIO_API_KEY ?? "",
  zernioBaseUrl: process.env.ZERNIO_BASE_URL ?? "https://zernio.com/api/v1",
  docusealApiKey: process.env.DOCUSEAL_API_KEY ?? "",
  docusealBaseUrl: process.env.DOCUSEAL_BASE_URL ?? "http://docuseal:3000",
  apolloApiKey: process.env.APOLLO_API_KEY ?? "",

  port: parseBoundedInteger("KARTA_PORT", process.env.KARTA_PORT, 4100, 1, 65_535),
  adminToken: runtimeEnvironment === "production"
    ? required("KARTA_ADMIN_TOKEN")
    : process.env.KARTA_ADMIN_TOKEN ?? "",
  dailyReportCron: process.env.DAILY_REPORT_CRON ?? "0 8 * * *",
};
