export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": Deno.env.get("CORS_ALLOWED_ORIGIN") === "*" ? "" : (Deno.env.get("CORS_ALLOWED_ORIGIN") ?? ""),
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });
}
