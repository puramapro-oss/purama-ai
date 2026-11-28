/** The state boundary only needs these RPCs. This structural capability keeps
 * the application's non-public schema without a cast to a public-schema SDK. */
interface OAuthStateStore {
  rpc(
    name: "create_oauth_connection_state" | "consume_oauth_connection_state",
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

export type OAuthPurpose = "google_connections" | "email_agent_gmail";
export type GoogleConnectionProvider = "google_sheets" | "gmail" | "google_calendar" | "google_drive";
export interface OAuthStateReceipt {
  userId: string;
  provider: GoogleConnectionProvider;
  returnPath: "/mes-connexions" | "/dashboard/email-agent";
}

export class OAuthStateError extends Error {
  constructor() { super("OAuth state storage unavailable"); this.name = "OAuthStateError"; }
}

export function isGoogleConnectionProvider(value: unknown): value is GoogleConnectionProvider {
  return value === "google_sheets" || value === "gmail" || value === "google_calendar" || value === "google_drive";
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

async function digest(state: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state))));
}

/** A server-generated secret crosses the browser/provider. Only its digest is
 * stored, with a SQL-owned lifetime and the verified initiating actor. */
export async function issueOAuthState(
  admin: OAuthStateStore,
  input: { userId: string; purpose: OAuthPurpose; provider: GoogleConnectionProvider },
): Promise<{ state: string; expiresAt: string }> {
  const state = hex(crypto.getRandomValues(new Uint8Array(32)));
  const { data, error } = await admin.rpc("create_oauth_connection_state", {
    p_state_hash: await digest(state), p_user_id: input.userId,
    p_purpose: input.purpose, p_provider: input.provider,
  });
  if (error || typeof data !== "string" || !Number.isFinite(Date.parse(data))) throw new OAuthStateError();
  return { state, expiresAt: data };
}

/** Consume before the first provider effect. Failure is not retried with this
 * state: the user starts a new flow if the provider outcome was interrupted. */
export async function consumeOAuthState(
  admin: OAuthStateStore,
  input: { state: string; purpose: OAuthPurpose; actorId: string },
): Promise<OAuthStateReceipt | null> {
  if (!/^[0-9a-f]{64}$/.test(input.state) || !input.actorId) return null;
  const { data, error } = await admin.rpc("consume_oauth_connection_state", {
    p_state_hash: await digest(input.state), p_purpose: input.purpose, p_actor_id: input.actorId,
  });
  if (error || !Array.isArray(data)) throw new OAuthStateError();
  if (data.length === 0) return null;
  if (data.length !== 1) throw new OAuthStateError();
  const receipt = data[0];
  const returnPath = input.purpose === "google_connections" ? "/mes-connexions" : "/dashboard/email-agent";
  if (!receipt || typeof receipt.user_id !== "string" || !receipt.user_id ||
      !isGoogleConnectionProvider(receipt.provider) || receipt.return_path !== returnPath ||
      receipt.user_id !== input.actorId ||
      (input.purpose === "email_agent_gmail" && receipt.provider !== "gmail")) throw new OAuthStateError();
  return { userId: receipt.user_id, provider: receipt.provider, returnPath };
}
