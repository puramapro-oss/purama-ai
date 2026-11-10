// This deliberately imports the production bridge, without the handler fixture map.
// npm: imports must resolve from the existing installation; no network permission.
import { ots } from "../../supabase/functions/_shared/ots-library.ts";
import fixtures from "./upstream-fixtures.json" with { type: "json" };

const upstream = fixtures.fixtures.find(value => value.fixture === "examples/hello-world.txt.ots")!;
const hash = Uint8Array.from("03ba204e50d126e4674c005e04d82e84c21366780af1f43bd54a37816b6ab340".match(/../g)!, value => parseInt(value, 16));
const blockHash = "000000000000000003e892881a8cdcdc117c06d444057c98b6f04a9ee75a2319";
const block = { id: blockHash, height: 358391, timestamp: 1432827678,
  merkle_root: "8a1b66ecb7cbd07d8139a7e7d7f2c41aab1f5009b8364aaf61d03ad245e47e00" };

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function withMetadata(merkleRoot: string, check: (calls: string[]) => Promise<void>) {
  const originalFetch = globalThis.fetch; const calls: string[] = [];
  globalThis.fetch = (input, init) => {
    const url = String(input); calls.push(url);
    assert(init?.redirect === "error" && init?.credentials === "omit", "bounded production transport options");
    if (url === "https://blockstream.info/api/block-height/358391") return Promise.resolve(new Response(blockHash));
    if (url === `https://blockstream.info/api/block/${blockHash}`) return Promise.resolve(Response.json({ ...block, merkle_root: merkleRoot }));
    return Promise.reject(new Error("Unexpected network destination"));
  };
  try { await check(calls); } finally { globalThis.fetch = originalFetch; }
}

Deno.test("production Deno npm bridge verifies the independent upstream block358391 proof offline", async () => {
  const permission = await Deno.permissions.query({ name: "net", host: "blockstream.info" });
  assert(permission.state !== "granted", "This runtime gate must not have network permission");
  await withMetadata(block.merkle_root, async calls => {
    const result = await ots.verifyDigest(hash, upstream.base64, false);
    assert(result.bitcoin?.height === block.height && result.bitcoin.timestamp === block.timestamp, "genuine upstream attestation result");
    assert(calls.length === 2, "only the two fixed metadata ports are called");
  });
});
Deno.test("production Deno npm bridge rejects a wrong independent Merkle root offline", async () => {
  await withMetadata("ab".repeat(32), async calls => {
    let error: unknown;
    try { await ots.verifyDigest(hash, upstream.base64, false); } catch (value) { error = value; }
    assert(error instanceof Error && error.message === "OTS_INVALID_ATTESTATION", "upstream cryptographic rejection");
    assert(calls.length === 2, "only fixed metadata was consulted");
  });
});
Deno.test("production Deno npm bridge rejects a changed document digest before transport", async () => {
  await withMetadata(block.merkle_root, async calls => {
    const wrongHash = hash.slice(); wrongHash[0] ^= 1;
    let error: unknown;
    try { await ots.verifyDigest(wrongHash, upstream.base64, true); } catch (value) { error = value; }
    assert(error instanceof Error && error.message === "OTS_HASH_MISMATCH", "changed document is rejected");
    assert(calls.length === 0, "no metadata or calendar call");
  });
});
