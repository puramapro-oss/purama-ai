import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Variable d'environnement manquante: ${name}`);
  }
  return value;
}

export const config = {
  supabaseUrl: required("SUPABASE_URL", "https://auth.purama.dev"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY", ""),
  schema: "purama_ai" as const,

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicModelMain: required("ANTHROPIC_MODEL_MAIN", "claude-sonnet-4-6"),
  anthropicModelFast: required("ANTHROPIC_MODEL_FAST", "claude-haiku-4-5-20251001"),
  // Voir .env.example : mock actif tant que le crédit Anthropic n'est pas rechargé (règle permanente 2026-07-26).
  mockClaude: (process.env.KARTA_MOCK_CLAUDE ?? "true") !== "false",

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

  port: Number(process.env.KARTA_PORT ?? 4100),
  adminToken: process.env.KARTA_ADMIN_TOKEN ?? "",
  dailyReportCron: process.env.DAILY_REPORT_CRON ?? "0 8 * * *",
};
