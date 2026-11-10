import { otsAdminClient, OtsHttpError } from "./ots-auth.ts";
import { readRequestText, RequestBodyError } from "./request-body.ts";

export interface OtsContract {
  id: string; user_id: string; status: string; docuseal_submission_id: number | null;
  ots_stamp_hash: string | null; ots_proof: string | null; ots_verified_at: string | null;
  ots_block_height: number | null; ots_btc_timestamp: string | null;
}
const FIELDS = "id,user_id,status,docuseal_submission_id,ots_stamp_hash,ots_proof,ots_verified_at,ots_block_height,ots_btc_timestamp";
const SNAPSHOT_FIELDS = ["id", "user_id", "status", "docuseal_submission_id", "ots_stamp_hash", "ots_proof"] as const;
export async function loadOtsContract(client: ReturnType<typeof otsAdminClient>, id: string): Promise<OtsContract> {
  const { data, error } = await client.from("contracts").select(FIELDS).eq("id", id).maybeSingle();
  if (error) throw new OtsHttpError(503, "Contract access unavailable");
  if (!data) throw new OtsHttpError(404, "Contract not found or unauthorized");
  return data as OtsContract;
}
export function requireUnchangedContract(expected: OtsContract, actual: OtsContract): void {
  if (SNAPSHOT_FIELDS.some(key => expected[key] !== actual[key])) throw new OtsHttpError(409, "Contract changed; retry verification");
}
export function conditionOnSnapshot<T extends { eq(column: string, value: unknown): T; is(column: string, value: null): T }>(query: T, contract: OtsContract): T {
  let result = query;
  for (const key of SNAPSHOT_FIELDS) result = contract[key] === null ? result.is(key, null) : result.eq(key, contract[key]);
  return result;
}
export async function readOtsBody(req: Request, maxBytes = 4096, timeoutMs = 5000): Promise<Record<string, unknown>> {
  try {
    const text = await readRequestText(req, { maxBytes, timeoutMs });
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid shape");
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestBodyError) throw new OtsHttpError(error.status, error.message);
    throw new OtsHttpError(400, "Invalid JSON");
  }
}
