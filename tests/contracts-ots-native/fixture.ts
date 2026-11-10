import OpenTimestamps from "../../node_modules/opentimestamps/index.js";
import notary from "../../node_modules/opentimestamps/src/notary.js";
import calendar from "../../node_modules/opentimestamps/src/calendar.js";

// Network and database ports only. The tests import the actual edge handlers.
export const SERVICE = "fixture-service-credential";
export const ANON = "fixture-anon-key";
export const OWNER = "11111111-1111-4111-8111-111111111111";
export const ADMIN = "22222222-2222-4222-8222-222222222222";
export const CONTRACT = "33333333-3333-4333-8333-333333333333";
export const PDF = new TextEncoder().encode("%PDF-1.7 synthetic signed document");
export const handlers: Array<(req: Request) => Promise<Response>> = [];
export function serve(handler: (req: Request) => Promise<Response>) { handlers.push(handler); }

type FixtureRow = Record<string, unknown>;
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
  eventsFailure: false,
  authFailure: false,
  afterPdf: undefined as (() => void) | undefined,
  afterVerify: undefined as (() => void) | undefined,
  bitcoin: undefined as { height: number; timestamp: number } | undefined,
};

export function reset() {
  Object.assign(state, {
    contract: { id: CONTRACT, user_id: OWNER, status: "signed", docuseal_submission_id: 17,
      ots_stamp_hash: "ab".repeat(32), ots_proof: btoa("fixture-proof"), ots_verified_at: null,
      ots_block_height: null, ots_btc_timestamp: null, pdf_original_url: null },
    allCalendarsFail: false, administrator: true, authCalls: 0, clients: [], writes: [], requests: [], signers: [], stampCalls: 0,
    verifyCalls: 0, deserializeCalls: 0, pdfUrl: "https://docuseal.fixture.invalid/signed.pdf", documentMetadata: undefined,
    pdfFailure: false, updateFailure: false, eventsFailure: false, authFailure: false,
    afterPdf: undefined, afterVerify: undefined, bitcoin: undefined,
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
    auth: { getUser: async (token?: string) => {
      state.authCalls++;
      const id = identity(token ? `Bearer ${token}` : authorization);
      return { data: { user: id && !state.authFailure ? { id } : null }, error: id && !state.authFailure ? null : { message: "fixture-private-auth-error" } };
    } },
    rpc: async (_name: string, args: Record<string, unknown>) => ({ data: args._user_id === ADMIN && state.administrator, error: null }),
    from: <Table extends string>(table: Table) => {
      type Row = Table extends "contract_signers" ? { signed: boolean } : FixtureRow;
      const filters: Array<[string, unknown]> = [];
      let operation = "select"; let values: Record<string, unknown> = {};
      const execute = (): FixtureResult => {
        if (table === "user_roles") return { data: identity(authorization) === ADMIN && state.administrator ? { role: "admin" } : null, error: null };
        if (table === "contract_signers" && operation === "select") return { data: state.signers, error: null };
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

// Reuse the actual locked 0.4.9 implementation in native Deno. Only calendar
// I/O is replaced; real Merkle construction, attestations and serialization run.
const OTS = {
  ...OpenTimestamps,
  stamp: async (detached: unknown) => {
    state.stampCalls++;
    const original = calendar.RemoteCalendar.prototype.submit;
    calendar.RemoteCalendar.prototype.submit = async (commitment: number[]) => {
      if (state.allCalendarsFail) throw new Error("fixture-calendar-unavailable");
      const result = OpenTimestamps.DetachedTimestampFile.fromHash(
        new OpenTimestamps.Ops.OpSHA256(), commitment,
      ).timestamp;
      result.attestations.push(new notary.PendingAttestation("https://alice.btc.calendar.opentimestamps.org"));
      return result;
    };
    try { await OpenTimestamps.stamp(detached); }
    finally { calendar.RemoteCalendar.prototype.submit = original; }
  },
};
export default OTS;

export function installNetworkFixture() {
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const headers = new Headers(init?.headers);
    state.requests.push({ url, redirect: init?.redirect, token: headers.get("X-Auth-Token"), authorization: headers.get("authorization"), body: typeof init?.body === "string" ? init.body : null });
    if (url === "https://supabase.fixture.invalid/functions/v1/contracts-ots-stamp") return Response.json({ ok: true });
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
