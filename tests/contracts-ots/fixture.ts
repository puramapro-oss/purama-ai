// Network and database ports only. The tests import the actual edge handlers.
export const SERVICE = "fixture-service-credential";
export const ANON = "fixture-anon-key";
export const OWNER = "11111111-1111-4111-8111-111111111111";
export const ADMIN = "22222222-2222-4222-8222-222222222222";
export const CONTRACT = "33333333-3333-4333-8333-333333333333";
export const PDF = new TextEncoder().encode("%PDF-1.7 synthetic signed document");
export const handlers: Array<(req: Request) => Promise<Response>> = [];
export function serve(handler: (req: Request) => Promise<Response>) { handlers.push(handler); }
// Replace only server registration inside this isolated test worker.
Object.defineProperty(Deno, "serve", { value: serve });

export const state = {
  contract: {} as Record<string, unknown>,
  administrator: true,
  authCalls: 0,
  clients: [] as Array<{ service: boolean; authorization: string }>,
  stampRpcs: [] as Array<{ name: string; args: Record<string, unknown>; service: boolean; authorization: string }>,
  writes: [] as Array<{ table: string; values: Record<string, unknown>; service: boolean }>,
  requests: [] as Array<{ url: string; redirect: RequestRedirect | undefined; token: string | null; authorization: string | null; body: string | null }>,
  signers: [] as Array<{ signed: boolean }>,
  stampCalls: 0,
  verifyCalls: 0,
  deserializeCalls: 0,
  pdfUrl: "https://docuseal.fixture.invalid/signed.pdf",
  documentMetadata: undefined as Record<string, unknown> | undefined,
  pdfFailure: false,
  updateFailure: false,
  eventsFailure: false,
  authFailure: false,
  afterPdf: undefined as (() => void) | undefined,
  afterVerify: undefined as (() => void) | undefined,
  internalStamp: undefined as ((request: Request) => Promise<Response>) | undefined,
  bitcoin: undefined as { height: number; timestamp: number } | undefined,
};

export function reset() {
  Object.assign(state, {
    contract: { id: CONTRACT, user_id: OWNER, status: "signed", docuseal_submission_id: 17,
      ots_stamp_hash: "ab".repeat(32), ots_proof: btoa("fixture-proof"), ots_verified_at: null,
      ots_block_height: null, ots_btc_timestamp: null, pdf_original_url: null },
    administrator: true, authCalls: 0, clients: [], stampRpcs: [], writes: [], requests: [], signers: [], stampCalls: 0,
    verifyCalls: 0, deserializeCalls: 0, pdfUrl: "https://docuseal.fixture.invalid/signed.pdf", documentMetadata: undefined,
    pdfFailure: false, updateFailure: false, eventsFailure: false, authFailure: false,
    afterPdf: undefined, afterVerify: undefined, internalStamp: undefined, bitcoin: undefined,
  });
}

function identity(authorization: string): string | null {
  if (authorization === "Bearer fixture-owner") return OWNER;
  if (authorization === "Bearer fixture-admin") return ADMIN;
  if (authorization === "Bearer fixture-foreign") return "44444444-4444-4444-8444-444444444444";
  return null;
}

export function createClient(_url: string, key: string, options?: { global?: { headers?: { Authorization?: string } }; db?: { schema: string }; auth?: { persistSession?: boolean; autoRefreshToken?: boolean; detectSessionInUrl?: boolean } }) {
  const service = key === SERVICE;
  const authorization = options?.global?.headers?.Authorization ?? "";
  state.clients.push({ service, authorization });
  const visible = () => service || identity(authorization) === state.contract.user_id ||
    (identity(authorization) === ADMIN && state.administrator);
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "persist_contract_ots_verification") {
        if (!service || options?.db?.schema !== "purama_ai") throw new Error("Verification requires the service persistence boundary");
        const fields = { id: "p_contract_id", user_id: "p_user_id", status: "p_status", docuseal_submission_id: "p_submission_id",
          ots_stamp_hash: "p_previous_hash", ots_proof: "p_previous_proof", ots_verified_at: "p_previous_verified_at",
          ots_block_height: "p_previous_block_height", ots_btc_timestamp: "p_previous_btc_timestamp" };
        if (!Object.entries(fields).every(([field, argument]) => state.contract[field] === args[argument])) return { data: null, error: null };
        // HTTP port only: native verification-atomicity.mjs executes the actual
        // migration for rollback, privileges, actor validation and row locking.
        if (state.updateFailure || state.eventsFailure) return { data: null, error: { message: "fixture-private-transaction-error" } };
        if (state.contract.ots_verified_at && state.contract.ots_proof === args.p_proof
          && state.contract.ots_block_height === args.p_block_height
          && Date.parse(String(state.contract.ots_btc_timestamp)) === Date.parse(String(args.p_btc_timestamp))) {
          return { data: state.contract.id, error: null };
        }
        const values = { ots_proof: args.p_proof, ots_verified_at: new Date().toISOString(),
          ots_block_height: args.p_block_height, ots_btc_timestamp: args.p_btc_timestamp };
        Object.assign(state.contract, values);
        state.writes.push({ table: "contracts", values, service });
        state.writes.push({ table: "contract_events", service, values: {
          contract_id: args.p_contract_id, event_type: "ots_verified",
          payload: { block_height: args.p_block_height, btc_timestamp: args.p_btc_timestamp },
          actor_id: args.p_actor_id, actor_type: args.p_actor_type,
        } });
        return { data: state.contract.id, error: null };
      }
      if (name !== "persist_contract_ots_stamp") throw new Error("Unexpected mutation RPC");
      state.stampRpcs.push({ name, args, service, authorization });
      const matches = (service || (identity(authorization) === ADMIN && state.administrator)) &&
        state.contract.id === args.p_contract_id && state.contract.user_id === args.p_user_id &&
        state.contract.status === "signed" && state.contract.docuseal_submission_id === args.p_submission_id &&
        state.contract.ots_stamp_hash === args.p_previous_hash && state.contract.ots_proof === args.p_previous_proof;
      if (!matches) return { data: null, error: null };
      // This models a single failed RPC for HTTP tests. The actual migration's
      // rollback, privileges, actor and races are tested by native-postgres.py.
      if (state.updateFailure || state.eventsFailure) return { data: null, error: { message: "fixture-private-transaction-error" } };
      const values = { ots_stamp_hash: args.p_hash, ots_proof: args.p_proof,
        ots_verified_at: null, ots_block_height: null, ots_btc_timestamp: null };
      Object.assign(state.contract, values);
      state.writes.push({ table: "contracts", values, service });
      state.writes.push({ table: "contract_events", service, values: {
        contract_id: args.p_contract_id, event_type: "ots_stamped",
        payload: { hash: args.p_hash, proof_size: atob(String(args.p_proof)).length },
        actor_id: service ? null : identity(authorization), actor_type: service ? "service" : "user",
      } });
      return { data: state.contract.id, error: null };
    },
    auth: { getUser: async (token?: string) => {
      state.authCalls++;
      const id = identity(token ? `Bearer ${token}` : authorization);
      return { data: { user: id && !state.authFailure ? { id } : null }, error: id && !state.authFailure ? null : { message: "fixture-private-auth-error" } };
    } },
    schema: (name: string) => {
      if (name !== "public") throw new Error("Role lookup must use public.has_role");
      return { rpc: async (rpc: string, args: Record<string, unknown>) => {
        if (rpc !== "has_role" || args._role !== "admin") throw new Error("Unexpected authority lookup");
        return { data: args._user_id === ADMIN && state.administrator, error: null };
      } };
    },
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let operation = "select"; let values: Record<string, unknown> = {};
      const execute = () => {
        if (table === "user_roles") return { data: identity(authorization) === ADMIN && state.administrator ? { role: "admin" } : null, error: null };
        if (table === "contract_signers") {
          if (!service || !filters.some(([key, value]) => key === "contract_id" && value === state.contract.id)) {
            return { data: null, error: null };
          }
          if (operation === "select") return { data: state.signers, error: null };
          // This synthetic submission has submitter 17. Confirm a matching row;
          // never turn a missing signer or unrelated contract into a successful write.
          if (!filters.some(([key, value]) => key === "docuseal_submitter_id" && value === 17)) return { data: null, error: null };
          if (state.updateFailure) return { data: null, error: { message: "fixture-private-database-error" } };
          state.writes.push({ table, values, service });
          return { data: { id: "fixture-signer-17" }, error: null };
        }
        if (operation === "insert") {
          if (state.eventsFailure) return { data: null, error: { message: "fixture-private-event-error" } };
          state.writes.push({ table, values, service });
          return { data: {}, error: null };
        }
        const matches = visible() && filters.every(([key, value]) => state.contract[key] === value);
        if (!matches) return { data: null, error: null };
        if (operation === "update") {
          if (state.updateFailure) return { data: null, error: { message: "fixture-private-database-error" } };
          state.writes.push({ table, values, service }); Object.assign(state.contract, values);
        }
        // Supabase's ungenerated schema boundary returns an untyped row too.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { data: structuredClone(state.contract) as any, error: null };
      };
      const query = {
        select: (_fields?: string) => query,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
        is: (key: string, value: unknown) => { filters.push([key, value]); return query; },
        update: (next: Record<string, unknown>) => { operation = "update"; values = next; return query; },
        insert: (next: Record<string, unknown>) => { operation = "insert"; values = next; return query; },
        maybeSingle: async () => execute(),
        single: async () => execute(),
        then: (resolve: (value: ReturnType<typeof execute>) => unknown) => Promise.resolve(execute()).then(resolve),
      };
      return query;
    },
  };
}

class OpSHA256 { _TAG() { return 8; } }
class OpAppend { constructor(_bytes: number[]) {} }
class PendingAttestation { constructor(public uri: string) {} }
class BitcoinBlockHeaderAttestation {
  constructor(public height: number) {}
  verifyAgainstBlockheader(_msg: number[], header: { time: number }) { return header.time; }
}
class Timestamp {
  ops = new Map<unknown, Timestamp>();
  attestations: Array<PendingAttestation | BitcoinBlockHeaderAttestation> = [];
  constructor(public msg: number[]) {}
  add(operation: unknown) { const child = new Timestamp(this.msg); this.ops.set(operation, child); return child; }
  merge(other: Timestamp) { this.attestations.push(...other.attestations); }
  static deserialize(_ctx: unknown, digest: number[]) {
    const result = new Timestamp(digest);
    result.attestations.push(new PendingAttestation("https://alice.btc.calendar.opentimestamps.org"));
    return result;
  }
}
class Detached {
  fileHashOp = new OpSHA256();
  timestamp: Timestamp;
  constructor(private digest: number[]) { this.timestamp = new Timestamp(digest); }
  fileDigest() { return this.digest; }
  serializeToBytes() { return Array.from(new TextEncoder().encode("fixture-proof")); }
  static fromHash(_op: unknown, digest: ArrayLike<number>) { return new Detached(Array.from(digest)); }
  static deserialize(_proof: Uint8Array) {
    state.deserializeCalls++;
    const result = new Detached(Array.from({ length: 32 }, () => 0xab));
    if (state.bitcoin) result.timestamp.attestations.push(new BitcoinBlockHeaderAttestation(state.bitcoin.height));
    else result.timestamp.attestations.push(new PendingAttestation("https://alice.btc.calendar.opentimestamps.org"));
    return result;
  }
}
const OTS = {
  Ops: { OpSHA256, OpAppend }, DetachedTimestampFile: Detached, Timestamp,
  Context: { StreamDeserialization: class { constructor(_bytes: unknown) {} assertEof() {} } },
  Notary: { PendingAttestation, BitcoinBlockHeaderAttestation },
  makeMerkleTree: (files: Detached[]) => files[0].timestamp,
  stamp: async (_detached: Detached) => { state.stampCalls++; },
  upgrade: async (_detached: Detached) => false,
  verify: async (_proof: Detached, _original: Detached) => { state.verifyCalls++; state.afterVerify?.(); return state.bitcoin ? { bitcoin: state.bitcoin } : {}; },
};
export default OTS;

export function installNetworkFixture() {
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const headers = new Headers(init?.headers);
    state.requests.push({ url, redirect: init?.redirect, token: headers.get("X-Auth-Token"), authorization: headers.get("authorization"), body: typeof init?.body === "string" ? init.body : null });
    if (url === "https://supabase.fixture.invalid/functions/v1/contracts-ots-stamp") {
      return state.internalStamp ? state.internalStamp(new Request(url, init)) : Response.json({ ok: true });
    }
    if (url.startsWith("https://docuseal.fixture.invalid/api/submissions/")) {
      return Response.json(state.documentMetadata ?? { combined_document_url: state.pdfUrl });
    }
    if (url === state.pdfUrl) {
      if (state.pdfFailure) throw new Error("fixture-private-provider-secret");
      state.afterPdf?.();
      return new Response(PDF, { headers: { "Content-Type": "application/pdf", "Content-Length": String(PDF.length) } });
    }
    if (url.endsWith("/digest")) { state.stampCalls++; return new Response(new Uint8Array([1, 2, 3])); }
    if (url.includes("/timestamp/")) return new Response(null, { status: 404 });
    if (url.startsWith("https://blockstream.info/api/block-height/")) return new Response("cd".repeat(32));
    if (url.startsWith("https://blockstream.info/api/block/")) {
      state.verifyCalls++; state.afterVerify?.();
      return Response.json({ id: "cd".repeat(32), height: state.bitcoin?.height, merkle_root: "ab".repeat(32), timestamp: state.bitcoin?.timestamp });
    }
    throw new Error("Unexpected network destination in closed fixture");
  };
}
