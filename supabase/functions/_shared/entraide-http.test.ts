import {
  assertEntraideRateLimit,
  entraideErrorResponse,
  EntraideHttpError,
  entraideJson,
  entraideRouteParts,
  readEntraideJson,
} from "./entraide-http.ts";

function assert(
  condition: unknown,
  message = "Assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );
}

async function expectHttpError(
  operation: () => unknown | Promise<unknown>,
  status: number,
  code: string,
): Promise<EntraideHttpError> {
  try {
    await operation();
  } catch (error) {
    assert(
      error instanceof EntraideHttpError,
      "Expected a classified HTTP error",
    );
    equal(error.status, status);
    equal(error.code, code);
    return error;
  }
  throw new Error("Expected operation to fail");
}

const url = "https://example.test/functions/v1/entraide-contact";
const cors = new Headers({
  "Access-Control-Allow-Origin": "https://purama.example",
});

Deno.test("JSON responses preserve numeric status and Headers-based CORS", async () => {
  const response = entraideJson({ created: true }, 201, cors);
  equal(response.status, 201);
  equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://purama.example",
  );
  equal(
    response.headers.get("Content-Type"),
    "application/json; charset=utf-8",
  );
  equal(response.headers.get("Cache-Control"), "no-store");
  equal(await response.json(), { created: true });
  equal(cors.get("Content-Type"), null);
});

Deno.test("classified errors retain status, safe message, CORS and retry header", async () => {
  const error = new EntraideHttpError(
    429,
    "rate_limited",
    "Réessayez plus tard",
    {
      "Retry-After": "60",
    },
  );
  const response = entraideErrorResponse(error, cors);
  equal(response.status, 429);
  equal(response.headers.get("Retry-After"), "60");
  equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://purama.example",
  );
  equal(await response.json(), {
    error: "rate_limited",
    message: "Réessayez plus tard",
  });
});

Deno.test("unclassified errors never expose internal database or exception details", async () => {
  for (
    const error of [
      new Error("private credentials and stack information"),
      { code: "42501", message: "private table name", details: "private SQL" },
    ]
  ) {
    const response = entraideErrorResponse(error, cors);
    equal(response.status, 500);
    equal(await response.json(), {
      error: "internal_error",
      message: "Erreur serveur",
    });
    equal(
      response.headers.get("Access-Control-Allow-Origin"),
      "https://purama.example",
    );
  }
});

Deno.test("rate limit receives the user-scoped key and the actual three-argument contract", () => {
  let call: unknown[] | undefined;
  assertEntraideRateLimit(
    "person-a",
    "entraide-send",
    15,
    60_000,
    (...args) => {
      call = args;
      return { allowed: true, remaining: 14 };
    },
  );
  equal(call, ["entraide-send:person-a", 15, 60_000]);
});

Deno.test("denied rate limit becomes an actionable 429 instead of being ignored", async () => {
  const error = await expectHttpError(
    () =>
      assertEntraideRateLimit("person-a", "entraide-send", 1, 1_501, () => ({
        allowed: false,
        remaining: 0,
      })),
    429,
    "rate_limited",
  );
  equal(error.headers.get("Retry-After"), "2");
});

Deno.test("the real in-memory limiter keeps users and buckets independent", async () => {
  const bucket = `test-${crypto.randomUUID()}`;
  assertEntraideRateLimit("person-a", bucket, 1);
  await expectHttpError(
    () => assertEntraideRateLimit("person-a", bucket, 1),
    429,
    "rate_limited",
  );
  assertEntraideRateLimit("person-b", bucket, 1);
  assertEntraideRateLimit("person-a", `${bucket}-other`, 1);
});

Deno.test("bounded JSON reader accepts valid UTF-8 exactly at its byte limit", async () => {
  const body = JSON.stringify({ message: "Aide solidaire é 🤝" });
  const bytes = new TextEncoder().encode(body);
  equal(
    await readEntraideJson(
      new Request(url, { method: "POST", body }),
      bytes.byteLength,
    ),
    { message: "Aide solidaire é 🤝" },
  );
  await expectHttpError(
    () =>
      readEntraideJson(
        new Request(url, { method: "POST", body }),
        bytes.byteLength - 1,
      ),
    413,
    "request_too_large",
  );
});

Deno.test("missing, empty and malformed JSON are client errors", async () => {
  for (const body of [undefined, "", "{", "undefined"]) {
    await expectHttpError(
      () => readEntraideJson(new Request(url, { method: "POST", body })),
      400,
      "invalid_request",
    );
  }
});

Deno.test("oversized declared body is rejected before reading", async () => {
  let read = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      read = true;
      controller.enqueue(new TextEncoder().encode("{}"));
      controller.close();
    },
  }, { highWaterMark: 0 });
  await expectHttpError(
    () =>
      readEntraideJson(
        new Request(url, {
          method: "POST",
          headers: { "Content-Length": "16385" },
          body,
        }),
      ),
    413,
    "request_too_large",
  );
  equal(read, false);
  await body.cancel();
});

Deno.test("actual streamed size is enforced without trusting Content-Length", async () => {
  for (const headers of [undefined, { "Content-Length": "1" }]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":"'));
        controller.enqueue(new TextEncoder().encode("1234567890"));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expectHttpError(
      () =>
        readEntraideJson(
          new Request(url, { method: "POST", body, headers }),
          10,
        ),
      413,
      "request_too_large",
    );
    equal(cancelled, true);
  }
});

Deno.test("invalid UTF-8 and interrupted streams produce safe client errors", async () => {
  await expectHttpError(
    () =>
      readEntraideJson(
        new Request(url, {
          method: "POST",
          body: new Uint8Array([0x22, 0xff, 0x22]),
        }),
      ),
    400,
    "invalid_request",
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("private transport information"));
    },
  });
  const error = await expectHttpError(
    () => readEntraideJson(new Request(url, { method: "POST", body })),
    400,
    "invalid_request",
  );
  assert(!error.message.includes("private"));
});

Deno.test("routes accept exact local and gateway paths with optional trailing slash", () => {
  for (
    const prefix of ["/entraide-contact", "/functions/v1/entraide-contact"]
  ) {
    for (const suffix of ["", "/", "?limit=5"]) {
      equal(
        entraideRouteParts(
          new Request(`https://example.test${prefix}${suffix}`),
          "entraide-contact",
        ),
        [],
      );
    }
    equal(
      entraideRouteParts(
        new Request(`https://example.test${prefix}/request-id/respond/`),
        "entraide-contact",
      ),
      ["request-id", "respond"],
    );
  }
});

Deno.test("routes reject prefix collisions, wrong functions and empty path segments", async () => {
  for (
    const path of [
      "/entraide-contact-evil",
      "/entraide-profil",
      "/other/entraide-contact",
      "/entraide-contact//respond",
      "/entraide-contact/request-id//respond",
    ]
  ) {
    await expectHttpError(
      () =>
        entraideRouteParts(
          new Request(`https://example.test${path}`),
          "entraide-contact",
        ),
      404,
      "not_found",
    );
  }
});

Deno.test("routes reject encoded separators, control characters and malformed escapes", async () => {
  for (const segment of ["%2F", "%5C", "%00", "%0a", "%7f"]) {
    await expectHttpError(
      () =>
        entraideRouteParts(
          new Request(`${url}/${segment}/respond`),
          "entraide-contact",
        ),
      404,
      "not_found",
    );
  }
  await expectHttpError(
    () =>
      entraideRouteParts(new Request(`${url}/%ZZ/respond`), "entraide-contact"),
    400,
    "invalid_request",
  );
});
