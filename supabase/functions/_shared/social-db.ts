export type SocialSchema = "public" | "purama_ai";

/** Keep the existing runtime default; public deployments opt in explicitly. */
export function resolveSocialSchema(value?: string): SocialSchema {
  if (value === undefined) return "purama_ai";
  if (value === "public" || value === "purama_ai") return value;
  throw new Error("SOCIAL_DB_SCHEMA must be public or purama_ai");
}
