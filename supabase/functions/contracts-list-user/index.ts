// GET /functions/v1/contracts-list-user
// Returns contracts for the authenticated user (own) or for target user_id if admin.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { CORS_HEADERS, corsResponse, errorResponse } from "../_shared/docuseal.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "GET") return errorResponse("Method not allowed", 405);

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return errorResponse("Missing Authorization", 401);

  const url = new URL(req.url);
  const userIdParam = url.searchParams.get("user_id");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 200);
  const statusFilter = url.searchParams.get("status");
  const appSlugFilter = url.searchParams.get("app_slug");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    {
      db: { schema: "purama_ai" },
      global: { headers: { Authorization: authHeader } },
    },
  );

  try {
    let q = supabase
      .from("contracts")
      .select("id, app_slug, template_slug, status, commission_rate, created_at, signed_at, docuseal_submission_id, metadata")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (userIdParam) q = q.eq("user_id", userIdParam);
    if (statusFilter) q = q.eq("status", statusFilter);
    if (appSlugFilter) q = q.eq("app_slug", appSlugFilter);

    const { data, error } = await q;
    if (error) return errorResponse(error.message, 500);

    return corsResponse({ contracts: data ?? [], count: data?.length ?? 0 });
  } catch (err) {
    return errorResponse(`Internal error: ${(err as Error).message}`, 500);
  }
});
