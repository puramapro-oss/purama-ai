import DetachedTimestampFile from "../../node_modules/opentimestamps/src/detached-timestamp-file.js";
import Ops from "../../node_modules/opentimestamps/src/ops.js";
import notary from "../../node_modules/opentimestamps/src/notary.js";
import Context from "../../node_modules/opentimestamps/src/context.js";
import Timestamp from "../../node_modules/opentimestamps/src/timestamp.js";
import { createOtsClient, type OtsLibrary } from "../../src/lib/ots-core.ts";
import type { OtsContract } from "../../supabase/functions/_shared/ots-contract.ts";
const OpenTimestamps = { DetachedTimestampFile, Ops, Context, Timestamp, Notary: notary };

// Network and database ports only. The tests import the actual edge handlers.
export const SERVICE = "fixture-service-credential";
export const ANON = "fixture-anon-key";
export const OWNER = "11111111-1111-4111-8111-111111111111";
export const ADMIN = "22222222-2222-4222-8222-222222222222";
export const CONTRACT = "33333333-3333-4333-8333-333333333333";
export const PDF = new TextEncoder().encode("%PDF-1.7 synthetic signed document");
export const handlers: Array<(req: Request) => Promise<Response>> = [];
export function serve(handler: (req: Request) => Promise<Response>) { handlers.push(handler); }
Object.defineProperty(Deno, "serve", { value: serve });

type FixtureRow = Record<string, unknown> & Partial<OtsContract>;
type FixtureResult = {
  data: FixtureRow | FixtureRow[] | null;
  error: { message: string } | null;
};

export const state = {
  contract: {} as Record<string, unknown>,
  administrator: true,
  authCalls: 0,
  clients: [] as Array<{ service: boolean; authorization: string }>,
  writes: [] as Array<{ table: string; values: Record<string, unknown>; service: boolean }>,
  stampRpcs: [] as Array<{ name: string; args: Record<string, unknown>; service: boolean; authorization: string }>,
  requests: [] as Array<{ url: string; redirect: RequestRedirect | undefined; token: string | null; authorization: string | null; body: string | null }>,
  signers: [] as Array<{ signed: boolean }>,
  allCalendarsFail: false,
  stampCalls: 0,
  verifyCalls: 0,
  deserializeCalls: 0,
  pdfUrl: "https://docuseal.fixture.invalid/signed.pdf",
  documentMetadata: undefined as Record<string, unknown> | undefined,
  pdfFailure: false,
  updateFailure: false,
  proofUpdateFailure: false,
  eventsFailure: false,
  authFailure: false,
  afterPdf: undefined as (() => void) | undefined,
  afterVerify: undefined as (() => void) | undefined,
  bitcoin: undefined as { height: number; timestamp: number } | undefined,
  internalHandler: undefined as ((request: Request) => Promise<Response>) | undefined,
};

export function reset() {
  Object.assign(state, {
    contract: { id: CONTRACT, user_id: OWNER, status: "signed", docuseal_submission_id: 17,
      ots_stamp_hash: "ab".repeat(32), ots_proof: btoa("fixture-proof"), ots_verified_at: null,
      ots_block_height: null, ots_btc_timestamp: null, pdf_original_url: null },
    allCalendarsFail: false, administrator: true, authCalls: 0, clients: [], writes: [], stampRpcs: [], requests: [], signers: [], stampCalls: 0,
    verifyCalls: 0, deserializeCalls: 0, pdfUrl: "https://docuseal.fixture.invalid/signed.pdf", documentMetadata: undefined,
    pdfFailure: false, updateFailure: false, proofUpdateFailure: false, eventsFailure: false, authFailure: false,
    afterPdf: undefined, afterVerify: undefined, bitcoin: undefined, internalHandler: undefined,
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
  const rpc = async (name: string, args: Record<string, unknown>, schema: string | undefined) => {
    if (schema !== "public" || name !== "has_role" || args._role !== "admin") {
      throw new Error("Authority RPC must use public.has_role with the administrator role");
    }
    return { data: args._user_id === ADMIN && state.administrator, error: null };
  };
  return {
    auth: { getUser: async (token?: string) => {
      state.authCalls++;
      const id = identity(token ? `Bearer ${token}` : authorization);
      return { data: { user: id && !state.authFailure ? { id } : null }, error: id && !state.authFailure ? null : { message: "fixture-private-auth-error" } };
    } },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== "persist_contract_ots_stamp") return rpc(name, args, options?.db?.schema);
      if (options?.db?.schema !== "purama_ai") throw new Error("Mutation RPC must use the application schema");
      state.stampRpcs.push({ name, args, service, authorization });
      const matches = (service || (identity(authorization) === ADMIN && state.administrator)) &&
        state.contract.id === args.p_contract_id && state.contract.user_id === args.p_user_id &&
        state.contract.status === "signed" && state.contract.docuseal_submission_id === args.p_submission_id &&
        state.contract.ots_stamp_hash === args.p_previous_hash && state.contract.ots_proof === args.p_previous_proof;
      if (!matches) return { data: null, error: null };
      // Port the donor's transactional fixture: a failed persistence RPC cannot
      // mutate proof or audit. The SQL transaction is qualified by its native bench.
      if (state.updateFailure || state.proofUpdateFailure || state.eventsFailure) {
        return { data: null, error: { message: "fixture-private-transaction-error" } };
      }
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
    schema(name: string) {
      if (name !== "public") throw new Error("Authority RPC must use the public schema");
      return { rpc: (rpcName: string, args: Record<string, unknown>) => rpc(rpcName, args, name) };
    },
    from: <Table extends string>(table: Table) => {
      type Row = Table extends "contract_signers" ? { signed: boolean } : FixtureRow;
      const filters: Array<[string, unknown]> = [];
      let operation = "select"; let values: Record<string, unknown> = {};
      const execute = (): FixtureResult => {
        if (table === "user_roles") return { data: identity(authorization) === ADMIN && state.administrator ? { role: "admin" } : null, error: null };
        if (table === "contract_signers" && operation === "select") return { data: state.signers, error: null };
        if (table === "contract_signers" && operation === "update") {
          const signer: FixtureRow = { id: "fixture-signer", contract_id: CONTRACT, docuseal_submitter_id: 17 };
          if (!service || !filters.every(([key, value]) => signer[key] === value)) return { data: null, error: null };
          state.writes.push({ table, values, service });
          return { data: { id: signer.id }, error: null };
        }
        if (operation === "insert") {
          if (state.eventsFailure) return { data: null, error: { message: "fixture-private-event-error" } };
          state.writes.push({ table, values, service });
          return { data: {}, error: null };
        }
        const matches = visible() && filters.every(([key, value]) => state.contract[key] === value);
        if (!matches) return { data: null, error: null };
        if (operation === "update") {
          if (state.updateFailure || (state.proofUpdateFailure && values.ots_proof !== undefined)) {
            return { data: null, error: { message: "fixture-private-database-error" } };
          }
          state.writes.push({ table, values, service }); Object.assign(state.contract, values);
        }
        return { data: structuredClone(state.contract), error: null };
      };
      const single = async () => {
        const result = execute();
        return { ...result, data: Array.isArray(result.data) ? result.data[0] ?? null : result.data };
      };
      const rows = async () => {
        const result = execute();
        const data = result.data === null ? null : Array.isArray(result.data) ? result.data : [result.data];
        return { ...result, data: data as Row[] | null };
      };
      const query = {
        select: (_fields?: string) => query,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
        is: (key: string, value: unknown) => { filters.push([key, value]); return query; },
        update: (next: Record<string, unknown>) => { operation = "update"; values = next; return query; },
        insert: (next: Record<string, unknown>) => { operation = "insert"; values = next; return query; },
        maybeSingle: single,
        single,
        then: (resolve: (value: Awaited<ReturnType<typeof rows>>) => unknown) => rows().then(resolve),
      };
      return query;
    },
  };
}

// Import only the actual locked primitives. The legacy main entry also loads
// unused transport/Bluebird code and requests unrelated native permissions.
export default OpenTimestamps;

// Observe one logical stamp while running the published bounded core and real
// upstream proof primitives. Only HTTP calendar replies are synthetic.
const actualOts = createOtsClient({ DetachedTimestampFile: OpenTimestamps.DetachedTimestampFile,
  Ops: OpenTimestamps.Ops, Context, Timestamp, Notary: notary } as OtsLibrary);
export const ots = {
  ...actualOts,
  stampDigest: async (hash: Uint8Array) => { state.stampCalls++; return await actualOts.stampDigest(hash); },
};

export function installNetworkFixture() {
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const headers = new Headers(init?.headers);
    state.requests.push({ url, redirect: init?.redirect, token: headers.get("X-Auth-Token"), authorization: headers.get("authorization"), body: typeof init?.body === "string" ? init.body : null });
    if (url === "https://supabase.fixture.invalid/functions/v1/contracts-ots-stamp") {
      return state.internalHandler ? state.internalHandler(new Request(url, init)) : Response.json({ ok: true });
    }
    if (url.startsWith("https://docuseal.fixture.invalid/api/submissions/")) {
      return Response.json(state.documentMetadata ?? { combined_document_url: state.pdfUrl });
    }
    if (url === state.pdfUrl) {
      if (state.pdfFailure) throw new Error("fixture-private-provider-secret");
      state.afterPdf?.();
      return new Response(PDF, { headers: { "Content-Type": "application/pdf", "Content-Length": String(PDF.length) } });
    }
    if (url.endsWith("/digest")) {
      if (state.allCalendarsFail) throw new Error("fixture-calendar-unavailable");
      if (!(init?.body instanceof Uint8Array)) throw new Error("Unexpected calendar request body");
      const receipt = OpenTimestamps.DetachedTimestampFile.fromHash(
        new OpenTimestamps.Ops.OpSHA256(), Array.from(init.body),
      ).timestamp;
      receipt.attestations.push(new notary.PendingAttestation(new URL(url).origin));
      const encoded = new Context.StreamSerialization();
      receipt.serialize(encoded);
      return new Response(new Uint8Array(encoded.getOutput()));
    }
    if (url.includes("/timestamp/")) return new Response(null, { status: 404 });
    if (url.startsWith("https://blockstream.info/api/block-height/")) return new Response("cd".repeat(32));
    if (url.startsWith("https://blockstream.info/api/block/")) {
      state.verifyCalls++; state.afterVerify?.();
      return Response.json({ id: "cd".repeat(32), height: state.bitcoin?.height, merkle_root: "ab".repeat(32), timestamp: state.bitcoin?.timestamp });
    }
    throw new Error("Unexpected network destination in closed fixture");
  };
}
