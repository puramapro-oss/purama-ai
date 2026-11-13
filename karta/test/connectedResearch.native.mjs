// Explicit native socket qualification. Run outside Vitest's deny-network setup:
// node --import tsx --test test/connectedResearch.native.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createConnectedResearchClient } from "../src/knowledge/connected-research.ts";

const TARGET = "https://example.com/article";
const SEARCH = { id: "native-search", results: [{ title: "Article", url: TARGET, snippet: "Source excerpt" }] };

async function fixture(handler, run) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const transport = async (url, init) => {
    assert.equal(url, "https://api.perplexity.ai/search");
    const response = await fetch(`http://127.0.0.1:${address.port}/search`, init);
    // The injected transport is a host-owned test seam. Production has no
    // configurable API origin and rejects mismatched/redirected response URLs.
    Object.defineProperty(response, "url", { value: "https://api.perplexity.ai/search" });
    return response;
  };
  try { await run(transport); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("native HTTP: one real POST and fragmented UTF-8 response", async () => {
  const requests = [];
  await fixture(async (req, res) => {
    const buffers = [];
    for await (const chunk of req) buffers.push(Buffer.from(chunk));
    requests.push({ method: req.method, body: Buffer.concat(buffers).toString(), authorization: req.headers.authorization });
    const bytes = Buffer.from(JSON.stringify({ ...SEARCH, results: [{ ...SEARCH.results[0], snippet: "Vérifié ? Non : extrait cité." }] }));
    res.writeHead(200, { "Content-Type": "application/json" });
    for (let offset = 0; offset < bytes.length; offset += 7) res.write(bytes.subarray(offset, offset + 7));
    res.end();
  }, async transport => {
    const client = createConnectedResearchClient({ perplexityApiKey: "native-test-key", fetch: transport });
    const result = await client.search("Native HTTP", { limit: 1 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].authorization, "Bearer native-test-key");
    assert.equal(JSON.parse(requests[0].body).max_results, 1);
    assert.equal(result.sources[0].text, "Vérifié ? Non : extrait cité.");
    assert.equal(result.verificationStatus, "unverified");
    assert.equal(JSON.stringify(result).includes("native-test-key"), false);
  });
});

test("native HTTP: a redirect is never followed or retried", async () => {
  const paths = [];
  await fixture((req, res) => {
    paths.push(req.url);
    res.writeHead(307, { Location: "/secret-destination" });
    res.end();
  }, async transport => {
    const client = createConnectedResearchClient({ perplexityApiKey: "native-test-key", fetch: transport });
    await assert.rejects(client.search("Question"), error => error.code === "unavailable" && error.requestDispatched === true);
    assert.deepEqual(paths, ["/search"]);
  });
});

test("native HTTP: malformed truncated response is never accepted", async () => {
  await fixture((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"results":[{"title":"truncated');
  }, async transport => {
    const client = createConnectedResearchClient({ perplexityApiKey: "native-test-key", fetch: transport });
    await assert.rejects(client.search("Question"), error => error.code === "unavailable" && error.requestDispatched === true);
  });
});
