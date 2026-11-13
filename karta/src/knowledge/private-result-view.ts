/** Shared, dependency-free projection of private tool results for the UI and chat boundary. */
export type PrivateToolName = 'knowledge_search' | 'quantum_simulate';
export type PrivateToolResultStatus = 'complete' | 'empty' | 'partial' | 'failed';

export interface PrivateToolSource {
  source: 'crossref' | 'wikidata';
  native_id: string;
  label: string;
  url: string;
  retrieved_at: string;
}

/** A display projection. Large details and unrecognized fields never enter UI state. */
export interface PrivateToolResult {
  id: string;
  run_id: string;
  creator_agent_id: string;
  user_id: string;
  tool_name: PrivateToolName;
  payload: {
    schema_version: 1;
    tool_name: PrivateToolName;
    status: PrivateToolResultStatus;
    summary: string;
    sources: PrivateToolSource[];
  };
  created_at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPrivateToolResultId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

/** URLs must agree with a provider-native identifier; no provider HTML is used. */
export function privateToolSourceUrl(source: unknown): string | null {
  if (!record(source) || typeof source.native_id !== 'string') return null;
  if (source.source === 'crossref' && source.native_id.length <= 512
    // eslint-disable-next-line no-control-regex -- A DOI must not carry control bytes.
    && /^10\.\d{4,9}\/[^\s\u0000-\u001f\u007f]+$/i.test(source.native_id)) {
    try {
      return `https://doi.org/${source.native_id.toLowerCase().split('/').map(encodeURIComponent).join('/')}`;
    } catch { return null; }
  }
  if (source.source === 'wikidata' && /^Q[1-9]\d{0,19}$/.test(source.native_id)) {
    return `https://www.wikidata.org/wiki/${source.native_id}`;
  }
  return null;
}

export function parsePrivateToolResult(value: unknown, ownerId: string, agentId: string): PrivateToolResult | null {
  if (!isPrivateToolResultId(ownerId) || !isPrivateToolResultId(agentId)
    || !record(value) || !isPrivateToolResultId(value.id) || !isPrivateToolResultId(value.run_id)
    || typeof value.user_id !== 'string' || value.user_id.toLowerCase() !== ownerId.toLowerCase()
    || typeof value.creator_agent_id !== 'string' || value.creator_agent_id.toLowerCase() !== agentId.toLowerCase()
    || (value.tool_name !== 'knowledge_search' && value.tool_name !== 'quantum_simulate')
    || !timestamp(value.created_at) || !record(value.payload)) return null;
  const payload = value.payload;
  if (payload.schema_version !== 1 || payload.tool_name !== value.tool_name
    || typeof payload.status !== 'string' || !['complete', 'empty', 'partial', 'failed'].includes(payload.status)
    || typeof payload.summary !== 'string' || !payload.summary.trim() || payload.summary.length > 4_000
    || !Array.isArray(payload.sources) || payload.sources.length > 10
    || (value.tool_name === 'quantum_simulate' && payload.sources.length !== 0)) return null;
  const sources: PrivateToolSource[] = [];
  for (const source of payload.sources) {
    const url = privateToolSourceUrl(source);
    if (!record(source) || !url || source.url !== url || typeof source.label !== 'string'
      || !source.label.trim() || source.label.length > 256 || !timestamp(source.retrieved_at)) return null;
    sources.push({
      source: source.source as PrivateToolSource['source'], native_id: source.native_id as string,
      label: source.label, url, retrieved_at: source.retrieved_at,
    });
  }
  return {
    id: value.id.toLowerCase(), run_id: value.run_id.toLowerCase(),
    creator_agent_id: agentId.toLowerCase(), user_id: ownerId.toLowerCase(),
    tool_name: value.tool_name, created_at: value.created_at,
    payload: {
      schema_version: 1, tool_name: value.tool_name, status: payload.status as PrivateToolResultStatus,
      summary: payload.summary, sources,
    },
  };
}
