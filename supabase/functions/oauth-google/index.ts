import { createClient } from "npm:@supabase/supabase-js@2.91.0";
import { cancelResponseQuietly, createRequestDeadline, RequestDeadlineError } from "../../../src/lib/request-deadline.ts";
import { readRequestText, readBoundedBytes, RequestBodyError } from "../_shared/request-body.ts";
import {
  consumeOAuthState, issueOAuthState, isGoogleConnectionProvider, OAuthStateError,
  type GoogleConnectionProvider,
} from "../_shared/oauth-state.ts";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const SCOPES: Record<GoogleConnectionProvider, string> = {
  google_sheets: "https://www.googleapis.com/auth/spreadsheets",
  gmail: "https://www.googleapis.com/auth/gmail.modify",
  google_calendar: "https://www.googleapis.com/auth/calendar",
  google_drive: "https://www.googleapis.com/auth/drive.file",
};
class OAuthHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers });
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, limit = 8192): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit;
}

/** Human authorization precedes every service-role or Google operation. The
 * state registry owns purpose, actor, lifetime and single-use admission. */
export async function handleOAuthGoogle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers });
  const deadlineAt = performance.now() + 15_000;
  const deadline = createRequestDeadline(15_000, req.signal);
  try {
    deadline.check();
    const token = /^Bearer ([^\s]+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
    if (!token) throw new OAuthHttpError(401, "Authentication required");
    if (req.method !== "POST") throw new OAuthHttpError(405, "Use POST to restart the connection");

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !anonKey || !serviceKey) throw new OAuthHttpError(503, "Connection service unavailable");
    const fetchWithin: typeof fetch = (input, init) => {
      const request = input instanceof Request ? input : null;
      return deadline.fetch(new URL(request ? request.url : String(input)), {
        ...(request ? { method: request.method, headers: request.headers, body: request.body } : {}),
        ...init, redirect: "error", credentials: "omit",
      });
    };
    const clientOptions = {
      db: { schema: "purama_ai" as const },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: fetchWithin },
    };
    const userClient = createClient(supabaseUrl, anonKey, clientOptions);
    const authenticate = async () => {
      const { data, error } = await deadline.wait(() => userClient.auth.getUser(token));
      if (error || !data.user?.id) throw new OAuthHttpError(401, "Authentication required");
      return data.user.id;
    };
    const actorId = await authenticate();
    deadline.check();

    let body: Record<string, unknown>;
    try {
      const decoded: unknown = JSON.parse(await deadline.wait(() => readRequestText(req, { maxBytes: 16_384, timeoutMs: 5_000 })));
      if (!object(decoded)) throw new OAuthHttpError(400, "Invalid request");
      body = decoded;
    } catch (error) {
      if (error instanceof RequestBodyError || error instanceof RequestDeadlineError || error instanceof OAuthHttpError) throw error;
      deadline.check();
      throw new OAuthHttpError(400, "Invalid request");
    }
    const action = body.action;
    const queryAction = new URL(req.url).searchParams.get("action");
    const fields = action === "authorize" ? ["action", "provider"]
      : action === "callback" ? ["action", "code", "state"]
      : action === "refresh" ? ["action", "provider", "userId"] : null;
    if (!fields || Object.keys(body).some(key => !fields.includes(key)) || (queryAction && queryAction !== action)) {
      throw new OAuthHttpError(400, "Invalid connection action");
    }
    if (action !== "callback" && !isGoogleConnectionProvider(body.provider)) throw new OAuthHttpError(400, "Invalid provider");
    if (body.userId !== undefined && body.userId !== actorId) throw new OAuthHttpError(403, "Connection belongs to another account");
    if (action === "callback" && (!text(body.code) || typeof body.state !== "string" || !/^[0-9a-f]{64}$/.test(body.state))) {
      throw new OAuthHttpError(400, "Invalid or obsolete connection state");
    }

    const clientId = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
    const redirectUri = Deno.env.get("GOOGLE_OAUTH_REDIRECT_URI") ?? "https://purama-ai.purama.dev/oauth/callback";
    let redirect: URL;
    try { redirect = new URL(redirectUri); } catch { throw new OAuthHttpError(503, "Google connection unavailable"); }
    if (!clientId || !clientSecret || redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.search || redirect.hash) {
      throw new OAuthHttpError(503, "Google connection unavailable");
    }
    deadline.check();
    const admin = createClient(supabaseUrl, serviceKey, clientOptions);

    if (action === "authorize") {
      const provider = body.provider as GoogleConnectionProvider;
      const issued = await deadline.wait(() => issueOAuthState(admin, { userId: actorId, purpose: "google_connections", provider }));
      deadline.check();
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      for (const [name, value] of Object.entries({ client_id: clientId, redirect_uri: redirect.href,
        response_type: "code", scope: SCOPES[provider], state: issued.state,
        access_type: "offline", prompt: "consent", include_granted_scopes: "true" })) authUrl.searchParams.set(name, value);
      return json({ authUrl: authUrl.href, state: issued.state, expiresAt: issued.expiresAt });
    }

    let provider: GoogleConnectionProvider;
    let refreshToken: string | undefined;
    let connectionId: string | undefined;
    let previousUpdatedAt: string | undefined;
    let returnUrl: string | undefined;
    if (action === "callback") {
      const state = await deadline.wait(() => consumeOAuthState(admin, {
        state: body.state as string, purpose: "google_connections", actorId,
      }));
      if (!state) throw new OAuthHttpError(409, "Connection expired or already used. Start again.");
      provider = state.provider; returnUrl = state.returnPath;
    } else {
      provider = body.provider as GoogleConnectionProvider;
      const { data, error } = await deadline.wait(async () => await admin.from("user_connections")
        .select("id,refresh_token,updated_at").eq("user_id", actorId).eq("provider", provider).maybeSingle());
      if (error) throw new OAuthHttpError(503, "Connection storage unavailable");
      if (!data || !text(data.refresh_token) || !text(data.id) || !text(data.updated_at)) {
        throw new OAuthHttpError(409, "Reconnect this Google account");
      }
      refreshToken = data.refresh_token; connectionId = data.id; previousUpdatedAt = data.updated_at;
    }

    deadline.check();
    const tokenBody = new URLSearchParams({ client_id: clientId, client_secret: clientSecret,
      grant_type: action === "callback" ? "authorization_code" : "refresh_token" });
    if (action === "callback") { tokenBody.set("code", body.code as string); tokenBody.set("redirect_uri", redirect.href); }
    else tokenBody.set("refresh_token", refreshToken!);
    let tokens: Record<string, unknown>;
    let response: Response | undefined;
    try {
      response = await deadline.fetch(new URL("https://oauth2.googleapis.com/token"), {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenBody, redirect: "error", credentials: "omit",
      });
      if (!response.ok || response.redirected) throw new OAuthHttpError(502, "Google refused the connection. Start again.");
      const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
      const bytes = await deadline.wait(() => readBoundedBytes({ body: response!.body, headers: response!.headers, signal: req.signal }, {
        maxBytes: 64_000, deadline: deadlineAt, matchContentLength: !encoding || encoding === "identity",
      }));
      deadline.check();
      const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!object(decoded)) throw new OAuthHttpError(502, "Invalid Google response");
      tokens = decoded;
    } catch (error) {
      deadline.check();
      if (error instanceof RequestDeadlineError || error instanceof OAuthHttpError) throw error;
      if (error instanceof RequestBodyError && error.status === 408) throw new OAuthHttpError(504, "Google connection timed out");
      throw new OAuthHttpError(502, "Google connection unavailable. Start again.");
    } finally { cancelResponseQuietly(response?.body); }

    if (!text(tokens.access_token) || typeof tokens.token_type !== "string" || tokens.token_type.toLowerCase() !== "bearer"
      || typeof tokens.expires_in !== "number" || !Number.isSafeInteger(tokens.expires_in) || tokens.expires_in <= 0
      || (tokens.refresh_token !== undefined && !text(tokens.refresh_token))) {
      throw new OAuthHttpError(502, "Invalid Google response");
    }
    // Google supports granular consent. A declared scope list is authoritative;
    // an unrelated or broader-looking string is not the exact requested grant.
    if (tokens.scope !== undefined && (typeof tokens.scope !== "string" || !tokens.scope.split(" ").includes(SCOPES[provider]))) {
      throw new OAuthHttpError(403, "Required Google permission was not granted. Reconnect with consent.");
    }
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    if (!Number.isFinite(expiresAt.valueOf())) throw new OAuthHttpError(502, "Invalid Google token lifetime");
    // There is no Google subject on legacy user_connections. Reusing an old
    // refresh token after selecting another Google account would mix identities.
    if (action === "callback" && !text(tokens.refresh_token)) throw new OAuthHttpError(502, "Offline access was not granted. Reconnect with consent.");
    const currentActor = await authenticate();
    if (currentActor !== actorId) throw new OAuthHttpError(401, "Authentication changed");
    deadline.check();
    const values = { user_id: actorId, provider, access_token: tokens.access_token,
      refresh_token: (tokens.refresh_token as string | undefined) ?? refreshToken!, token_expires_at: expiresAt.toISOString() };
    const write = action === "callback"
      ? admin.from("user_connections").upsert(values, { onConflict: "user_id,provider" }).select("id").maybeSingle()
      : admin.from("user_connections").update(values).eq("id", connectionId!).eq("user_id", actorId)
        .eq("provider", provider).eq("refresh_token", refreshToken!).eq("updated_at", previousUpdatedAt!).select("id").maybeSingle();
    const { data: written, error: writeError } = await deadline.wait(async () => await write);
    if (writeError) throw new OAuthHttpError(503, "Connection persistence unavailable. Start again.");
    if (!written?.id) throw new OAuthHttpError(409, "Connection changed. Reload before retrying.");
    deadline.check();
    return json({ success: true, provider, expiresAt: expiresAt.toISOString(), ...(returnUrl ? { returnUrl } : {}) });
  } catch (error) {
    if (error instanceof RequestDeadlineError) return json({ error: "Connection timed out. Start again." }, 504);
    if (req.signal.aborted || (error instanceof Error && error.name === "AbortError")) return json({ error: "Connection cancelled" }, 408);
    if (error instanceof RequestBodyError) return json({ error: "Invalid request body" }, error.status);
    if (error instanceof OAuthStateError) return json({ error: "Connection state unavailable. Start again." }, 503);
    if (error instanceof OAuthHttpError) return json({ error: error.message }, error.status);
    return json({ error: "Connection service unavailable. Start again." }, 503);
  } finally { deadline.close(); }
}

Deno.serve(handleOAuthGoogle);
