import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.91.0";

export const billingCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

export class BillingError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export function billingJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { ...billingCors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export function billingOrigin(): string {
  const configured = Deno.env.get("PURAMA_BILLING_ORIGIN") ?? "https://purama-ai.purama.dev";
  try {
    const url = new URL(configured);
    if (url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) return url.origin;
  } catch { /* Reject misconfiguration before creating a session. */ }
  throw new BillingError(503, "billing_configuration", "La facturation est momentanément indisponible.");
}

export function stripeRedirect(value: unknown, hostname: string): string {
  try {
    if (typeof value !== "string") throw new Error();
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === hostname && !url.port && !url.username && !url.password) return url.href;
  } catch { /* Do not expose a provider's invalid response. */ }
  throw new BillingError(502, "invalid_billing_response", "Le lien de paiement est indisponible. Réessaie dans un instant.");
}

export async function billingKey(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `purama-${Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, "0")).join("")}`;
}

function createBillingDatabase(url: string, key: string, requestFetch: typeof fetch) {
  return createClient(url, key, {
    db: { schema: "purama_ai" }, auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: requestFetch },
  });
}

type Client = ReturnType<typeof createBillingDatabase>;
export interface BillingContext {
  db: Client;
  stripe: Stripe;
  user: { id: string; email: string };
  check: () => void;
}

/** One deadline includes auth, database and Stripe. Every side effect must follow check(). */
export async function withBillingRequest(req: Request, work: (context: BillingContext) => Promise<Response>): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: billingCors });
  if (req.method !== "POST") return billingJson({ error: "Méthode non autorisée.", code: "method_not_allowed" }, 405);
  const token = /^Bearer ([^\s]+)$/i.exec(req.headers.get("Authorization") ?? "")?.[1];
  if (!token) return billingJson({ error: "Connecte-toi pour accéder à la facturation.", code: "unauthenticated" }, 401);
  const controller = new AbortController();
  const deadline = performance.now() + 15_000;
  let failure: BillingError | undefined;
  let rejectStopped: (error: BillingError) => void = () => {};
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  void stopped.catch(() => {});
  const stop = (error: BillingError) => {
    if (!failure) { failure = error; controller.abort(); rejectStopped(error); }
  };
  const interrupted = () => stop(new BillingError(408, "request_interrupted", "La demande a été interrompue."));
  const check = () => {
    if (req.signal.aborted) interrupted();
    if (!failure && performance.now() >= deadline) stop(new BillingError(504, "billing_timeout", "La facturation met trop de temps à répondre. Réessaie dans un instant."));
    if (failure) throw failure;
  };
  const timer = setTimeout(() => stop(new BillingError(504, "billing_timeout", "La facturation met trop de temps à répondre. Réessaie dans un instant.")), 15_000);
  req.signal.addEventListener("abort", interrupted, { once: true });
  const boundedFetch: typeof fetch = (input, init) => {
    check();
    const original = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = original ? AbortSignal.any([original, controller.signal]) : controller.signal;
    return fetch(input, { ...init, signal });
  };
  try {
    check();
    const result = await Promise.race([stopped, (async () => {
      const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!stripeKey || !supabaseUrl || !serviceKey) throw new BillingError(503, "billing_configuration", "La facturation est momentanément indisponible.");
      billingOrigin();
      const db = createBillingDatabase(supabaseUrl, serviceKey, boundedFetch);
      const { data, error } = await db.auth.getUser(token);
      check();
      if (error || !data.user?.id || !data.user.email) throw new BillingError(401, "unauthenticated", "Connecte-toi pour accéder à la facturation.");
      const stripe = new Stripe(stripeKey, {
        apiVersion: "2025-08-27.basil", httpClient: Stripe.createFetchHttpClient(boundedFetch), timeout: 10_000, maxNetworkRetries: 0,
      });
      const response = await work({ db, stripe, user: { id: data.user.id, email: data.user.email }, check });
      check();
      return response;
    })()]);
    check();
    return result;
  } catch (error) {
    const known = failure ?? (error instanceof BillingError ? error : undefined);
    console.error("[BILLING]", known?.code ?? "provider_unavailable");
    return billingJson({ error: known?.message ?? "La facturation est momentanément indisponible. Réessaie dans un instant.", code: known?.code ?? "provider_unavailable" }, known?.status ?? 503);
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener("abort", interrupted);
    controller.abort();
  }
}

export interface BillingSubscription { user_id: string; plan_type: string; status: string; stripe_customer_id: string | null }

export async function billingSubscription(ctx: BillingContext): Promise<BillingSubscription | null> {
  const { data, error } = await ctx.db.from("subscriptions").select("user_id, plan_type, status, stripe_customer_id").eq("user_id", ctx.user.id).maybeSingle();
  ctx.check();
  if (error) throw new BillingError(503, "subscription_unavailable", "Impossible de vérifier ton abonnement. Réessaie dans un instant.");
  return data as BillingSubscription | null;
}

/** Email is a discovery hint, never proof of ownership. Ambiguous legacy records fail closed. */
export async function billingCustomer(ctx: BillingContext, row: BillingSubscription | null, create: boolean): Promise<string> {
  const conflict = () => new BillingError(409, "customer_reconciliation_required", "Le rattachement de ton compte de facturation doit être vérifié par le support.");
  let customer: Stripe.Customer | Stripe.DeletedCustomer | undefined;
  if (row?.stripe_customer_id) {
    customer = await ctx.stripe.customers.retrieve(row.stripe_customer_id);
    ctx.check();
    if (customer.id !== row.stripe_customer_id || customer.deleted || (customer.metadata.user_id !== undefined && customer.metadata.user_id !== ctx.user.id)) throw conflict();
  } else {
    const candidates = await ctx.stripe.customers.list({ email: ctx.user.email, limit: 100 });
    ctx.check();
    if (candidates.has_more) throw conflict();
    if (candidates.data.length) {
      if (candidates.data.length !== 1 || candidates.data[0].metadata.user_id !== ctx.user.id) throw conflict();
      customer = candidates.data[0];
    }
  }
  if (customer) {
    const { data: bindings, error } = await ctx.db.from("subscriptions").select("user_id").eq("stripe_customer_id", customer.id).limit(2);
    ctx.check();
    if (error) throw new BillingError(503, "subscription_unavailable", "Impossible de vérifier ton abonnement.");
    if (!Array.isArray(bindings) || bindings.some(binding => binding.user_id !== ctx.user.id) || bindings.length > 1) throw conflict();
    return customer.id;
  }
  if (!create) throw new BillingError(409, "customer_missing", "Aucun compte de facturation n’est encore rattaché à ton compte.");
  const idempotencyKey = await billingKey(`customer-v1:${ctx.user.id}`);
  ctx.check();
  const created = await ctx.stripe.customers.create({ email: ctx.user.email, metadata: { user_id: ctx.user.id } }, { idempotencyKey });
  ctx.check();
  if (!created.id || created.metadata.user_id !== ctx.user.id) throw conflict();
  return created.id;
}
