// Transport policy adapted from SUTRA 9f876cbc/src/lib/ots-transport.ts.
// Only upstream OTS parsers, operations, Merkle nodes and attestation checks are used.
// Browser/Deno fetch cannot pin DNS like SUTRA's Node adapter: HTTPS authorities
// below are trusted, redirects are forbidden, and no caller-selected host is fetched.
import { cancelResponseQuietly, createRequestDeadline, RequestDeadlineError } from "./request-deadline.ts";

export interface OtsAttestation {
  uri?: string;
  height?: number;
  verifyAgainstBlockheader?(digest: number[], header: { merkleroot: string; time: number }): number;
}
export interface OtsTimestamp {
  msg: number[];
  ops: Map<unknown, OtsTimestamp>;
  attestations: OtsAttestation[];
  add(operation: unknown): OtsTimestamp;
  merge(other: OtsTimestamp): void;
}
export interface OtsDetached {
  fileHashOp: unknown;
  timestamp: OtsTimestamp;
  fileDigest(): number[];
  serializeToBytes(): number[];
}
export interface OtsLibrary {
  DetachedTimestampFile: { fromHash(op: unknown, hash: number[]): OtsDetached; deserialize(bytes: Uint8Array): OtsDetached };
  Ops: { OpSHA256: new () => unknown; OpAppend: new (bytes: number[]) => unknown };
  Context: { StreamDeserialization: new (bytes: Uint8Array) => { assertEof(): void } };
  Timestamp: { deserialize(context: unknown, digest: number[]): OtsTimestamp };
  Notary: {
    PendingAttestation: new (uri: string) => OtsAttestation & { uri: string };
    BitcoinBlockHeaderAttestation: new (height: number) => OtsAttestation & { height: number; verifyAgainstBlockheader(digest: number[], header: { merkleroot: string; time: number }): number };
  };
}

export const OTS_MAX_PROOF_BYTES = 64_000;
const AGGREGATORS = ["https://a.pool.opentimestamps.org", "https://b.pool.opentimestamps.org", "https://a.pool.eternitywall.com", "https://ots.btc.catallaxy.com"];
const CALENDAR_SUFFIXES = [".calendar.opentimestamps.org", ".calendar.eternitywall.com", ".calendar.catallaxy.com"];
const MAX_REQUESTS = 12;
const MAX_NODES = 256;
const MAX_ATTESTATIONS = 64;

export class OtsError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "OtsError"; }
}
function fail(code: string): never { throw new OtsError(code); }
export function calendarOrigin(value: string): string {
  if (value.includes("\\")) return fail("OTS_INVALID_CALENDAR");
  let url: URL;
  try { url = new URL(value); } catch { return fail("OTS_INVALID_CALENDAR"); }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || url.search || url.pathname !== "/"
    || (!AGGREGATORS.includes(url.origin) && !CALENDAR_SUFFIXES.some(suffix => url.hostname.endsWith(suffix)))) return fail("OTS_INVALID_CALENDAR");
  return url.origin;
}
export function proofFromBase64(value: unknown): Uint8Array {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(OTS_MAX_PROOF_BYTES / 3) * 4
    || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return fail("OTS_INVALID_PROOF");
  let binary: string;
  try { binary = atob(value); } catch { return fail("OTS_INVALID_PROOF"); }
  if (binary.length > OTS_MAX_PROOF_BYTES) return fail("OTS_INVALID_PROOF");
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
export function proofToBase64(bytes: ArrayLike<number>): string {
  if (!bytes.length || bytes.length > OTS_MAX_PROOF_BYTES) return fail("OTS_INVALID_PROOF");
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Bounded streaming, one fixed request, no redirects, credentials or cookies. */
export async function readOtsResponse(url: URL, body?: Uint8Array, maxBytes = 10_000): Promise<Uint8Array | null> {
  if (url.username || url.password || url.search || url.hash || url.port || url.protocol !== "https:") return fail("OTS_INVALID_URL");
  if (url.origin === "https://blockstream.info") {
    if (body || !/^\/api\/(?:block-height\/(?:0|[1-9][0-9]*)|block\/[a-f0-9]{64})$/.test(url.pathname)) return fail("OTS_INVALID_URL");
  } else {
    calendarOrigin(url.origin);
    if (body ? url.pathname !== "/digest" : !/^\/timestamp\/[a-f0-9]{2,8192}$/.test(url.pathname)) return fail("OTS_INVALID_URL");
  }
  const deadline = createRequestDeadline(10_000);
  try {
    const response = await deadline.fetch(url, { method: body ? "POST" : "GET", body: body ? new Uint8Array(body) : undefined,
      redirect: "error", credentials: "omit",
      headers: { Accept: "application/vnd.opentimestamps.v1, application/json, text/plain", ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) } });
    if (response.redirected) { cancelResponseQuietly(response.body); return fail("OTS_REDIRECT_REJECTED"); }
    if (response.status === 404 && url.pathname.startsWith("/timestamp/")) { cancelResponseQuietly(response.body); deadline.check(); return null; }
    if (response.status !== 200) { cancelResponseQuietly(response.body); return fail("OTS_HTTP_REJECTED"); }
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) { cancelResponseQuietly(response.body); return fail("OTS_RESPONSE_TOO_LARGE"); }
    const reader = response.body?.getReader();
    if (!reader) return fail("OTS_EMPTY_RESPONSE");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { value, done } = await deadline.wait(() => reader.read());
        if (done) break;
        size += value.length;
        if (size > maxBytes) return fail("OTS_RESPONSE_TOO_LARGE");
        if (value.length) chunks.push(value);
      }
    } catch (error) { cancelResponseQuietly(reader); throw error; }
    finally { try { reader.releaseLock(); } catch { /* A non-cooperative pending read can still hold its lock. */ } }
    if (declared && !response.headers.get("content-encoding") && size !== Number(declared)) return fail("OTS_INVALID_RESPONSE");
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    deadline.check(); return bytes;
  } catch (error) {
    if (error instanceof OtsError) throw error;
    return fail(error instanceof RequestDeadlineError ? "OTS_TIMEOUT" : "OTS_REQUEST_FAILED");
  } finally { deadline.close(); }
}

function nodes(root: OtsTimestamp): OtsTimestamp[] {
  const result: OtsTimestamp[] = []; const pending = [{ node: root, depth: 0 }]; const seen = new Set<OtsTimestamp>();
  let attestations = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (seen.has(node)) continue;
    seen.add(node); result.push(node); attestations += node.attestations.length;
    if (result.length > MAX_NODES || depth > 64 || attestations > MAX_ATTESTATIONS || node.msg.length > 4096) return fail("OTS_PROOF_TOO_COMPLEX");
    for (const child of node.ops.values()) pending.push({ node: child, depth: depth + 1 });
  }
  return result;
}
function hex(bytes: ArrayLike<number>): string { return Array.from(bytes).map(byte => byte.toString(16).padStart(2, "0")).join(""); }

export function createOtsClient(library: OtsLibrary) {
  function usable(attestation: OtsAttestation): boolean {
    if (attestation instanceof library.Notary.BitcoinBlockHeaderAttestation) return Number.isSafeInteger(attestation.height) && (attestation.height as number) >= 0;
    if (!(attestation instanceof library.Notary.PendingAttestation) || typeof attestation.uri !== "string") return false;
    try { calendarOrigin(attestation.uri); return true; } catch { return false; }
  }
  function parse(bytes: Uint8Array, digest: number[]): OtsTimestamp {
    try {
      const context = new library.Context.StreamDeserialization(bytes);
      const timestamp = library.Timestamp.deserialize(context, digest);
      context.assertEof(); nodes(timestamp); return timestamp;
    } catch { return fail("OTS_INVALID_RESPONSE"); }
  }
  async function stampDigest(hash: Uint8Array): Promise<string> {
    if (hash.length !== 32) return fail("OTS_INVALID_HASH");
    const detached = library.DetachedTimestampFile.fromHash(new library.Ops.OpSHA256(), Array.from(hash));
    // Same one-file nonce/Merkle construction as upstream makeMerkleTree().
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)));
    const tip = detached.timestamp.add(new library.Ops.OpAppend(nonce)).add(new library.Ops.OpSHA256());
    const replies = await Promise.all(AGGREGATORS.map(async origin => {
      try {
        const bytes = await readOtsResponse(new URL("/digest", calendarOrigin(origin)), new Uint8Array(tip.msg));
        if (!bytes) return null;
        const timestamp = parse(bytes, tip.msg);
        if (!nodes(timestamp).some(node => node.attestations.some(usable))) return null;
        return timestamp;
      } catch { return null; }
    }));
    const accepted = replies.filter((reply): reply is OtsTimestamp => reply !== null);
    // Upstream documents m=2 for its default four calendars; never report success
    // merely because all calendar failures were soft-failed.
    if (accepted.length < 2) return fail("OTS_CALENDAR_UNAVAILABLE");
    for (const reply of accepted) tip.merge(reply);
    nodes(detached.timestamp);
    return proofToBase64(detached.serializeToBytes());
  }
  async function verifyDigest(hash: Uint8Array, proof: string, upgrade: boolean) {
    if (hash.length !== 32) return fail("OTS_INVALID_HASH");
    const bytes = proofFromBase64(proof);
    let detached: OtsDetached;
    try { detached = library.DetachedTimestampFile.deserialize(bytes); } catch { return fail("OTS_INVALID_PROOF"); }
    if (!(detached.fileHashOp instanceof library.Ops.OpSHA256) || hex(detached.fileDigest()) !== hex(hash)) return fail("OTS_HASH_MISMATCH");
    let tree = nodes(detached.timestamp); let requests = 0;
    if (!tree.some(node => node.attestations.some(usable))) return fail("OTS_INVALID_PROOF");
    if (upgrade && !tree.some(node => node.attestations.some(attestation => attestation instanceof library.Notary.BitcoinBlockHeaderAttestation))) {
      const seen = new Set<string>(); let successfulCalendars = 0;
      for (const node of tree) for (const attestation of node.attestations.slice()) {
        if (!(attestation instanceof library.Notary.PendingAttestation) || typeof attestation.uri !== "string") continue;
        let origin: string;
        try { origin = calendarOrigin(attestation.uri); } catch { continue; }
        const path = `/timestamp/${hex(node.msg)}`; const key = origin + path;
        if (seen.has(key)) continue;
        seen.add(key); if (++requests > MAX_REQUESTS) return fail("OTS_REQUEST_LIMIT");
        try {
          const reply = await readOtsResponse(new URL(path, origin));
          if (reply) {
            const upgraded = parse(reply, node.msg);
            if (!nodes(upgraded).some(item => item.attestations.some(usable))) continue;
            node.merge(upgraded);
          }
          successfulCalendars++;
        } catch { /* Try the next admissible calendar within the same budget. */ }
      }
      if (seen.size && !successfulCalendars) return fail("OTS_CALENDAR_UNAVAILABLE");
      tree = nodes(detached.timestamp);
    }
    let bitcoin: { height: number; timestamp: number } | undefined;
    const blocks = new Map<number, { merkleroot: string; time: number }>();
    for (const node of tree) for (const attestation of node.attestations) {
      if (!(attestation instanceof library.Notary.BitcoinBlockHeaderAttestation)) continue;
      const height = attestation.height;
      if (!Number.isSafeInteger(height) || (height as number) < 0) return fail("OTS_INVALID_HEIGHT");
      let block = blocks.get(height as number);
      if (!block) {
        if ((requests += 2) > MAX_REQUESTS) return fail("OTS_REQUEST_LIMIT");
        const hashBytes = await readOtsResponse(new URL(`https://blockstream.info/api/block-height/${height}`));
        const blockHash = new TextDecoder().decode(hashBytes!);
        if (!/^[a-f0-9]{64}$/.test(blockHash)) return fail("OTS_INVALID_BLOCK_HASH");
        const infoBytes = await readOtsResponse(new URL(`https://blockstream.info/api/block/${blockHash}`), undefined, 64_000);
        let info: { merkle_root?: unknown; timestamp?: unknown; id?: unknown; height?: unknown };
        try { info = JSON.parse(new TextDecoder().decode(infoBytes!)); } catch { return fail("OTS_INVALID_BLOCK"); }
        if (!info || typeof info.merkle_root !== "string" || !/^[a-f0-9]{64}$/.test(info.merkle_root)
          || !Number.isSafeInteger(info.timestamp) || (info.timestamp as number) <= 0 || info.id !== blockHash || info.height !== height) return fail("OTS_INVALID_BLOCK");
        block = { merkleroot: info.merkle_root, time: info.timestamp as number }; blocks.set(height as number, block);
      }
      let timestamp: number;
      try { timestamp = attestation.verifyAgainstBlockheader!(node.msg.slice().reverse(), block); } catch { return fail("OTS_INVALID_ATTESTATION"); }
      if (!bitcoin || timestamp < bitcoin.timestamp) bitcoin = { height: height as number, timestamp };
    }
    return { bitcoin, proof: proofToBase64(detached.serializeToBytes()) };
  }
  return { stampDigest, verifyDigest };
}
