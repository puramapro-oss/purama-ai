// Explicit Deno entry point; kept outside Playwright's discovery convention.
import { handlers, installNetworkFixture, reset, state, SERVICE } from "./fixture.ts";

const SECRET = "fixture-docuseal-webhook-secret";
Deno.env.set("SUPABASE_URL", "https://supabase.fixture.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
Deno.env.set("DOCUSEAL_API_URL", "https://docuseal.fixture.invalid");
Deno.env.set("DOCUSEAL_API_TOKEN", "fixture-docuseal-private-token");
Deno.env.set("DOCUSEAL_WEBHOOK_SECRET", SECRET);
installNetworkFixture();
await import("../../supabase/functions/contracts-webhook/index.ts");
const [webhook] = handlers;

function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

for (const authorization of [null, "Bearer wrong", `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}x`]) {
  Deno.test(`native unauthorized webhook never reads body: ${authorization}`, async () => {
    reset();
    let reads = 0;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      pull() { reads++; },
    }, { highWaterMark: 0 });
    const headers = new Headers();
    if (authorization !== null) headers.set("Authorization", authorization);
    const request = new Request("https://function.fixture.invalid/webhook", { method: "POST", headers, body });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([webhook(request), new Promise<Response>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Invalid bearer waited for request body")), 250);
      })]);
      equal(response.status, 401);
      equal(reads, 0);
      equal(request.bodyUsed, false);
      equal(state.clients.length, 0);
      equal(state.requests.length, 0);
      equal(state.writes.length, 0);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller!.close();
    }
  });
}

Deno.test("native authenticated webhook still parses JSON", async () => {
  reset();
  const request = new Request("https://function.fixture.invalid/webhook", {
    method: "POST", headers: { Authorization: `Bearer ${SECRET}` }, body: "{",
  });
  equal((await webhook(request)).status, 400);
  equal(request.bodyUsed, true);
  equal(state.clients.length, 0);
  equal(state.requests.length, 0);
});
