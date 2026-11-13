// Bind the actual edge handler to a private loopback port for this integration check.
const serve = Deno.serve.bind(Deno);
Deno.serve = ((handler: Deno.ServeHandler) => serve({
  hostname: "127.0.0.1", port: Number(Deno.env.get("WORKSHOP_PRIVATE_EDGE_PORT")),
}, handler)) as typeof Deno.serve;
await import("../../supabase/functions/chef-workshop/index.ts");
