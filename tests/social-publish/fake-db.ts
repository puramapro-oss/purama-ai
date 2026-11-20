import type { SocialDbClient, SocialDbResult, SocialQuery, StoredSocialPost } from "../../supabase/functions/_shared/social-publish-store.ts";
import type { ProviderPublishResult, SocialAccountRef } from "../../supabase/functions/_shared/social-publish-core.ts";

export const NOW = Date.parse("2026-11-10T12:00:00.000Z");
export type Row = Record<string, unknown>;
type Filter = { key: string; op: "eq" | "in" | "lte" | "not_null"; value: unknown };
export type Fault = { when: (query: Query) => boolean; kind: "error" | "empty" | "after_error"; repeat?: boolean };

export class Query implements SocialQuery {
  op: "select" | "insert" | "update" = "select";
  values: Row = {};
  filters: Filter[] = [];
  columns = "*";
  maximum = Infinity;
  ordering?: { key: string; ascending: boolean };
  cardinality?: "single" | "maybeSingle";
  constructor(readonly db: FakeDb, readonly table: string) {}
  select(columns = "*"): this { this.columns = columns; return this; }
  insert(values: Row): this { this.op = "insert"; this.values = values; return this; }
  update(values: Row): this { this.op = "update"; this.values = values; return this; }
  eq(key: string, value: unknown): this { this.filters.push({ key, op: "eq", value }); return this; }
  is(key: string, value: null): this { return this.eq(key, value); }
  not(key: string, _operator: "is", value: null): this { this.filters.push({ key, op: "not_null", value }); return this; }
  in(key: string, value: unknown[]): this { this.filters.push({ key, op: "in", value }); return this; }
  lte(key: string, value: string): this { this.filters.push({ key, op: "lte", value }); return this; }
  limit(maximum: number): this { this.maximum = maximum; return this; }
  order(key: string, options = { ascending: true }): this { this.ordering = { key, ...options }; return this; }
  single(): this { this.cardinality = "single"; return this; }
  maybeSingle(): this { this.cardinality = "maybeSingle"; return this; }
  then<TResult1 = SocialDbResult, TResult2 = never>(
    onfulfilled?: ((value: SocialDbResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve().then(() => this.db.execute(this)).then(onfulfilled, onrejected);
  }
  matches(row: Row): boolean {
    return this.filters.every(({ key, op, value }) => op === "eq" ? row[key] === value
      : op === "not_null" ? row[key] !== null && row[key] !== undefined
      : op === "in" ? (value as unknown[]).includes(row[key])
      : row[key] !== null && row[key] !== undefined && String(row[key]) <= String(value));
  }
}

/** Atomic filter/update and unique insert, with returned-error fault injection. */
export class FakeDb implements SocialDbClient {
  tables: Record<string, Row[]>;
  queries: Query[] = [];
  faults: Fault[] = [];
  clock = NOW;
  nextId = 1;
  constructor(posts: StoredSocialPost[] = [], accounts: SocialAccountRef[] = [account()]) {
    this.tables = { social_posts: structuredClone(posts) as unknown as Row[], social_accounts: structuredClone(accounts) as unknown as Row[] };
  }
  from(table: string): Query { return new Query(this, table); }
  execute(query: Query): SocialDbResult {
    this.queries.push(query);
    const fault = this.faults.find((candidate) => candidate.when(query));
    if (fault && !fault.repeat) this.faults.splice(this.faults.indexOf(fault), 1);
    if (fault?.kind === "error") return { data: null, error: { code: "XX000", message: "Injected database error" } };
    if (fault?.kind === "empty") return { data: [], error: null };
    const table = this.tables[query.table] ?? [];
    let rows: Row[];
    if (query.op === "insert") {
      if (table.some((row) => query.values.client_request_id != null && row.user_id === query.values.user_id && row.client_request_id === query.values.client_request_id)) {
        return { data: null, error: { code: "23505", message: "Duplicate request identity" } };
      }
      const row: Row = {
        id: "post-" + this.nextId++, updated_at: new Date(this.clock).toISOString(),
        scheduled_at: null, published_at: null, error_message: null, zernio_post_id: null,
        platform_results: [], ...structuredClone(query.values),
      };
      table.push(row);
      rows = [row];
    } else {
      rows = table.filter((row) => query.matches(row));
      if (query.ordering) {
        const { key, ascending } = query.ordering;
        rows.sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (ascending ? 1 : -1));
      }
      rows = rows.slice(0, query.maximum);
      if (query.op === "update") {
        for (const row of rows) Object.assign(row, structuredClone(query.values), { updated_at: new Date(this.clock).toISOString() });
      }
    }
    if (fault?.kind === "after_error") return { data: null, error: { code: "08006", message: "Write acknowledged lost" } };
    const data = rows.map((row) => query.columns === "*" ? structuredClone(row)
      : Object.fromEntries(query.columns.split(",").map((column) => [column.trim(), structuredClone(row[column.trim()])])));
    if (query.cardinality) {
      if (data.length > 1 || (query.cardinality === "single" && data.length !== 1)) {
        return { data: null, error: { code: "PGRST116", message: "Invalid cardinality" } };
      }
      return { data: data[0] ?? null, error: null };
    }
    return { data, error: null };
  }
}

export function account(overrides: Partial<SocialAccountRef> = {}): SocialAccountRef {
  return { user_id: "owner", platform: "facebook", zernio_account_id: "account-owner", zernio_profile_id: "profile-owner", is_active: true, publishing_verified_at: "2026-11-09T12:00:00.000Z", ...overrides };
}

export function post(overrides: Partial<StoredSocialPost> = {}): StoredSocialPost {
  return {
    id: "existing-post", user_id: "owner", content_text: "PURAMA préparé", content_media_urls: [],
    target_platforms: ["facebook"], target_accounts: [{ platform: "facebook", zernio_account_id: "account-owner", zernio_profile_id: "profile-owner" }],
    status: "scheduled", client_request_id: null, request_hash: null,
    scheduled_at: "2026-11-10T11:00:00.000Z", updated_at: "2026-11-10T11:00:00.000Z",
    error_message: null, zernio_post_id: null, platform_results: [], ...overrides,
  };
}

export function providerResult(overrides: Partial<ProviderPublishResult> = {}): ProviderPublishResult {
  return { status: "published", externalPostId: "external-post", platformResults: [{ platform: "facebook", accountId: "account-owner", status: "published" }], response: {}, ...overrides };
}
