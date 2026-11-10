import { createClient } from "npm:@supabase/supabase-js@2.91.0";

export class OtsHttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
function equalCredential(left: string, right: string): boolean {
  if (!right || left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}
export async function authorizeOts(req: Request, administratorOnly = false) {
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!match) throw new OtsHttpError(401, "Authentication required");
  const token = match[1];
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!url || !serviceKey) throw new OtsHttpError(503, "Authentication unavailable");
  const options = { db: { schema: "purama_ai" as const }, auth: { persistSession: false, autoRefreshToken: false } };
  if (equalCredential(token, serviceKey)) return { client: createClient(url, serviceKey, options), userId: null, service: true };
  if (!anonKey) throw new OtsHttpError(503, "Authentication unavailable");
  const client = createClient(url, anonKey, { ...options, global: { headers: { Authorization: `Bearer ${token}` } } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user?.id) throw new OtsHttpError(401, "Authentication required");
  if (administratorOnly) {
    const { data: role, error: roleError } = await client.from("user_roles").select("role").eq("user_id", data.user.id).eq("role", "admin").maybeSingle();
    if (roleError || role?.role !== "admin") throw new OtsHttpError(403, "Administrator authorization required");
  }
  return { client, userId: data.user.id, service: false };
}
export function otsAdminClient() {
  return createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { db: { schema: "purama_ai" }, auth: { persistSession: false, autoRefreshToken: false } });
}
export function validContractId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
