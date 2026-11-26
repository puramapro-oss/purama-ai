/** Shared, dependency-free projection of private tool results for the UI and chat boundary. */
export type PrivateToolName = 'knowledge_search' | 'quantum_simulate' | 'programmatic_report' | 'qualify_resolution';
export type PrivateToolResultStatus = 'complete' | 'empty' | 'partial' | 'failed';

export const PROGRAMMATIC_REPORT_MAX_UTF16_UNITS = 60_000;
export const PROGRAMMATIC_REPORT_MAX_BYTES = 61_440;
export const PROGRAMMATIC_REPORT_READ_TOOLS = Object.freeze(['knowledge_search', 'web_search'] as const);
export const PROGRAMMATIC_REPORT_PROVENANCE = Object.freeze({
  content_kind: 'model_generated_report', verification_status: 'unverified',
  source_text_trust: 'untrusted_data', execution_mode: 'programmatic_reads', report_truncated: false,
} as const);

export const RESOLUTION_REPORT_MAX_BYTES = 61_440;
export const RESOLUTION_REPORT_PROVENANCE = Object.freeze({
  content_kind: 'resolution_qualification', verification_status: 'unverified',
  source_text_trust: 'untrusted_data', provenance: 'caller_supplied_snapshot',
  qualification_only: true, external_facts_verified: false, permissions_granted: false,
  external_actions_performed: 0, report_truncated: false,
} as const);
export const RESOLUTION_REPORT_SECTIONS = Object.freeze([
  { id: 'dependencies', title: 'Prérequis' },
  { id: 'transitions', title: 'Transitions' },
  { id: 'effort', title: 'Effort choisi' },
  { id: 'corrections', title: 'Conséquences d’une correction' },
  { id: 'occurrence', title: 'Récurrence et reprises' },
  { id: 'handoffs', title: 'Passation' },
] as const);
export interface ResolutionReportSection {
  id: (typeof RESOLUTION_REPORT_SECTIONS)[number]['id'];
  title: string;
  availability: 'provided' | 'not_provided';
  summary: string;
  items: string[];
}
export interface ResolutionSuppliedReference {
  id: string; caseId: string; snapshotRevision: number; subjectId: string;
  kind: 'requirement' | 'satisfaction' | 'alternative' | 'acceptance' | 'activation'
    | 'correction' | 'transmission' | 'responsibility' | 'performance' | 'authorization';
  reference: string; observedAt: string;
}
export interface ResolutionPrivateResultView {
  snapshot: { caseId: string; snapshotRevision: number; asOf: string };
  sections: ResolutionReportSection[];
  supplied_references: ResolutionSuppliedReference[];
  rejected_source_ids: string[];
}

/** Same strict instant semantics as the qualifier; an observation is not an event date. */
function resolutionInstant(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, y, m, d, h, min, sec, fraction, zone] = match;
  const year = Number(y), month = Number(m), day = Number(d), hour = Number(h), minute = Number(min), second = Number(sec);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return undefined;
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, Number((fraction ?? '').padEnd(3, '0')));
  if (new Date(wall).getUTCDate() !== day) return undefined;
  let offset = 0;
  if (zone !== 'Z') {
    const hours = Number(zone.slice(1, 3)), minutes = Number(zone.slice(4, 6));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return undefined;
    offset = (hours * 60 + minutes) * 60_000 * (zone[0] === '+' ? 1 : -1);
  }
  return wall - offset;
}

function resolutionObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function resolutionString(value: unknown, maximum: number, minimum = 1): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum
    && !value.includes('\u0000') && !/[\uD800-\uDFFF]/u.test(value);
}
function resolutionRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1_000_000;
}

/** Validate and copy only this version's complete display contract. No field is clipped. */
export function parseResolutionPrivatePayload(payload: unknown): ResolutionPrivateResultView | null {
  if (!resolutionObject(payload, ['schema_version', 'tool_name', 'status', 'summary', 'sources', 'details'])
    || payload.schema_version !== 1 || payload.tool_name !== 'qualify_resolution' || payload.status !== 'complete'
    || !resolutionString(payload.summary, 4_000) || !payload.summary.trim()
    || !Array.isArray(payload.sources) || payload.sources.length !== 0) return null;
  const details = payload.details;
  if (!resolutionObject(details, [...Object.keys(RESOLUTION_REPORT_PROVENANCE), 'snapshot', 'sections', 'supplied_references', 'rejected_source_ids'])
    || Object.entries(RESOLUTION_REPORT_PROVENANCE).some(([key, value]) => details[key] !== value)) return null;
  const snapshot = details.snapshot;
  if (!resolutionObject(snapshot, ['caseId', 'snapshotRevision', 'asOf'])
    || !resolutionString(snapshot.caseId, 160) || !resolutionRevision(snapshot.snapshotRevision)
    || !resolutionString(snapshot.asOf, 35, 20)) return null;
  const asOf = resolutionInstant(snapshot.asOf);
  if (asOf === undefined || !Array.isArray(details.sections) || details.sections.length !== 6) return null;
  const sections: ResolutionReportSection[] = [];
  let itemCount = 0;
  for (let index = 0; index < RESOLUTION_REPORT_SECTIONS.length; index++) {
    const section = details.sections[index], expected = RESOLUTION_REPORT_SECTIONS[index];
    if (!resolutionObject(section, ['id', 'title', 'availability', 'summary', 'items'])
      || section.id !== expected.id || section.title !== expected.title
      || (section.availability !== 'provided' && section.availability !== 'not_provided')
      || !resolutionString(section.summary, 1_000) || !section.summary.trim()
      || !Array.isArray(section.items) || section.items.some(item => !resolutionString(item, 8_192) || !item.trim())) return null;
    itemCount += section.items.length;
    if (itemCount > 2_048 || (section.availability === 'not_provided'
      && (section.items.length !== 0 || section.summary !== 'Aucune information fournie pour cette rubrique.'))) return null;
    sections.push({ ...expected, availability: section.availability, summary: section.summary, items: [...section.items] as string[] });
  }
  if (!Array.isArray(details.supplied_references) || details.supplied_references.length > 128
    || !Array.isArray(details.rejected_source_ids) || details.rejected_source_ids.length > 128
    || details.rejected_source_ids.some(id => !resolutionString(id, 160))) return null;
  const providedRejectedIds = details.rejected_source_ids;
  const supplied_references: ResolutionSuppliedReference[] = [];
  const rejected_source_ids: string[] = [];
  const referenceIds = new Set<string>();
  const kinds: readonly string[] = ['requirement', 'satisfaction', 'alternative', 'acceptance', 'activation',
    'correction', 'transmission', 'responsibility', 'performance', 'authorization'];
  for (const source of details.supplied_references) {
    if (!resolutionObject(source, ['id', 'caseId', 'snapshotRevision', 'subjectId', 'kind', 'reference', 'observedAt'])
      || !resolutionString(source.id, 160) || referenceIds.has(source.id)
      || !resolutionString(source.caseId, 160) || !resolutionRevision(source.snapshotRevision)
      || !resolutionString(source.subjectId, 160) || typeof source.kind !== 'string' || !kinds.includes(source.kind)
      || !resolutionString(source.reference, 500) || !resolutionString(source.observedAt, 35, 20)) return null;
    referenceIds.add(source.id);
    const observedAt = resolutionInstant(source.observedAt);
    if (source.caseId !== snapshot.caseId || source.snapshotRevision !== snapshot.snapshotRevision
      || observedAt === undefined || observedAt > asOf || !source.reference.trim()) rejected_source_ids.push(source.id);
    supplied_references.push({ id: source.id, caseId: source.caseId, snapshotRevision: source.snapshotRevision,
      subjectId: source.subjectId, kind: source.kind as ResolutionSuppliedReference['kind'],
      reference: source.reference, observedAt: source.observedAt });
  }
  if (rejected_source_ids.length !== providedRejectedIds.length
    || rejected_source_ids.some((id, index) => id !== providedRejectedIds[index])) return null;
  const projection: ResolutionPrivateResultView = {
    snapshot: { caseId: snapshot.caseId, snapshotRevision: snapshot.snapshotRevision, asOf: snapshot.asOf },
    sections, supplied_references, rejected_source_ids,
  };
  // Reconstruct known keys, never serialize arbitrary row fields or methods.
  const envelope = { schema_version: 1, tool_name: 'qualify_resolution', status: 'complete',
    summary: payload.summary, sources: [], details: { ...RESOLUTION_REPORT_PROVENANCE, ...projection } };
  if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > RESOLUTION_REPORT_MAX_BYTES) return null;
  return projection;
}

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
    resolution?: ResolutionPrivateResultView;
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

function validProgrammaticReport(payload: Record<string, unknown>): boolean {
  const details = payload.details;
  if (Object.keys(payload).length !== 6 || payload.status !== 'complete'
    || !Array.isArray(payload.sources) || payload.sources.length !== 0 || !record(details)
    || Object.keys(details).length !== 6
    || Object.entries(PROGRAMMATIC_REPORT_PROVENANCE).some(([key, value]) => details[key] !== value)
    || !Array.isArray(details.read_tools) || details.read_tools.length > PROGRAMMATIC_REPORT_READ_TOOLS.length
    || details.read_tools.some(tool => !PROGRAMMATIC_REPORT_READ_TOOLS.some(allowed => allowed === tool))
    || new Set(details.read_tools).size !== details.read_tools.length
    || typeof payload.summary !== 'string' || /[\uD800-\uDFFF]/u.test(payload.summary)
    || payload.summary.includes('\u0000')) return false;
  // Serialize the fixed projection, never arbitrary fields/toJSON from a row.
  const projected = {
    schema_version: 1, tool_name: 'programmatic_report', status: 'complete',
    summary: payload.summary, sources: [],
    details: { ...PROGRAMMATIC_REPORT_PROVENANCE, read_tools: [...details.read_tools] },
  };
  return new TextEncoder().encode(JSON.stringify(projected)).byteLength <= PROGRAMMATIC_REPORT_MAX_BYTES;
}

export function parsePrivateToolResult(value: unknown, ownerId: string, agentId: string): PrivateToolResult | null {
  if (!isPrivateToolResultId(ownerId) || !isPrivateToolResultId(agentId)
    || !record(value) || !isPrivateToolResultId(value.id) || !isPrivateToolResultId(value.run_id)
    || typeof value.user_id !== 'string' || value.user_id.toLowerCase() !== ownerId.toLowerCase()
    || typeof value.creator_agent_id !== 'string' || value.creator_agent_id.toLowerCase() !== agentId.toLowerCase()
    || (value.tool_name !== 'knowledge_search' && value.tool_name !== 'quantum_simulate' && value.tool_name !== 'programmatic_report' && value.tool_name !== 'qualify_resolution')
    || !timestamp(value.created_at) || !record(value.payload)) return null;
  const payload = value.payload;
  if (payload.schema_version !== 1 || payload.tool_name !== value.tool_name
    || typeof payload.status !== 'string' || !['complete', 'empty', 'partial', 'failed'].includes(payload.status)
    || typeof payload.summary !== 'string' || !payload.summary.trim()
    || payload.summary.length > (value.tool_name === 'programmatic_report' ? PROGRAMMATIC_REPORT_MAX_UTF16_UNITS : 4_000)
    || !Array.isArray(payload.sources) || payload.sources.length > 10
    || (value.tool_name === 'quantum_simulate' && payload.sources.length !== 0)
    || (value.tool_name === 'programmatic_report' && !validProgrammaticReport(payload))) return null;
  const resolution = value.tool_name === 'qualify_resolution' ? parseResolutionPrivatePayload(payload) : undefined;
  if (value.tool_name === 'qualify_resolution' && !resolution) return null;
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
      ...(resolution ? { resolution } : {}),
    },
  };
}
