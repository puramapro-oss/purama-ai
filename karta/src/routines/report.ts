import { normalizeRoutineInput, normalizeRoutineTimestamp, type Routine } from "./contracts.js";

export interface RoutineReportItem {
  id: string;
  agentType: string;
  status: string;
  mode: "live" | "simulation";
  mock: boolean;
  summary: string;
  finishedAt: string | null;
}

export interface RoutineReportCounts {
  success: number;
  error: number;
  awaiting: number;
  simulated: number;
  running: number;
  skipped: number;
  other: number;
}

export interface RoutineReport {
  title: string;
  body: string;
  sourceCount: number;
  hasNewActivity: boolean;
  window: { since: string; until: string };
  items: RoutineReportItem[];
  counts: RoutineReportCounts;
  /** True when the database selection, not merely the presentation, was capped. */
  truncated: boolean;
}

export class RoutineReportError extends Error {
  readonly code = "ROUTINE_REPORT_INVALID";
  constructor() {
    super("Le bilan ne peut pas être établi à partir des données reçues.");
    this.name = "RoutineReportError";
  }
}

export const ROUTINE_REPORT_MAX_CHARS = 5_000;
const MAX_ROWS = 500;
const MAX_SUMMARY_CHARS = 600;
const MAX_SOURCE_SUMMARY_CHARS = 128_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENT = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/;
const STATUS = /^[a-z][a-z0-9_-]{0,63}$/;
// eslint-disable-next-line no-control-regex -- Untrusted report summaries must not contain unsafe controls.
const INVALID_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]|[\ud800-\udfff]/u;
const ITEM_LIMIT = { express: 3, standard: 5, detailed: 10 } as const;
const BODY_SUMMARY_LIMIT = { express: 480, standard: 360, detailed: 240 } as const;
type ParsedTimestamp = { iso: string; micros: bigint };
type ParsedRun = RoutineReportItem & { startedAt: string; recency: bigint };

function fail(): never { throw new RoutineReportError(); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** PostgreSQL timestamps may contain six fractional digits; preserve comparison precision. */
function timestamp(value: unknown): ParsedTimestamp {
  if (typeof value !== "string") return fail();
  const fraction = /\.(\d{1,6})(?=Z|[+-]\d{2}:\d{2}$)/.exec(value);
  const milliseconds = fraction && fraction[1].length > 3
    ? value.replace(fraction[0], `.${fraction[1].slice(0, 3)}`) : value;
  try {
    const iso = normalizeRoutineTimestamp(milliseconds);
    const residual = fraction ? Number(fraction[1].padEnd(6, "0").slice(3)) : 0;
    return { iso, micros: BigInt(Date.parse(iso)) * 1000n + BigInt(residual) };
  } catch { return fail(); }
}

function shorten(value: string, max: number, suffix = "… [résumé abrégé]"): string {
  if (value.length <= max) return value;
  const prefix = value.slice(0, max - suffix.length).replace(/[\ud800-\udbff]$/u, "").trimEnd();
  return prefix + suffix;
}

function summary(value: unknown): string {
  if (value === null || value === "") return "Aucun résumé fourni.";
  if (typeof value !== "string" || value.length > MAX_SOURCE_SUMMARY_CHARS || INVALID_TEXT.test(value)) return fail();
  const singleLine = value.replace(/\s+/gu, " ").trim();
  return singleLine ? shorten(singleLine, MAX_SUMMARY_CHARS) : "Aucun résumé fourni.";
}

function parseRun(value: unknown, routine: Routine, since: ParsedTimestamp, until: ParsedTimestamp): ParsedRun {
  if (!isRecord(value) || value.user_id !== routine.userId ||
    typeof value.id !== "string" || !UUID.test(value.id) ||
    typeof value.agent_type !== "string" || !AGENT.test(value.agent_type) ||
    typeof value.status !== "string" || !STATUS.test(value.status) ||
    (value.mode !== "live" && value.mode !== "simulation") || typeof value.claude_mock !== "boolean") return fail();
  if (routine.config.agentTypes.length && !routine.config.agentTypes.includes(value.agent_type)) return fail();
  const started = timestamp(value.started_at);
  const finished = value.finished_at === null ? null : timestamp(value.finished_at);
  if (started.micros > until.micros || (finished && finished.micros < started.micros) ||
    (started.micros < since.micros && (!finished || finished.micros < since.micros))) return fail();
  const content = summary(value.result_summary);
  return {
    id: value.id, agentType: value.agent_type, status: value.status, mode: value.mode, mock: value.claude_mock,
    summary: content, finishedAt: finished?.iso ?? null, startedAt: started.iso,
    recency: finished?.micros ?? started.micros,
  };
}

function category(run: RoutineReportItem): keyof RoutineReportCounts {
  if (run.status === "success") return run.mode === "simulation" || run.mock ? "simulated" : "success";
  if (run.status === "simulated") return "simulated";
  if (run.status === "error") return "error";
  if (run.status === "awaiting_approval") return "awaiting";
  if (run.status === "running") return "running";
  if (run.status === "skipped") return "skipped";
  return "other";
}

function priority(run: RoutineReportItem): number {
  if (run.status === "error") return 0;
  if (run.status === "awaiting_approval" || run.status === "blocked" || run.status === "partial") return 1;
  return 2;
}

function label(run: RoutineReportItem): string {
  if (run.status === "success") return category(run) === "simulated"
    ? "simulation signalée réussie" : "exécution signalée réussie";
  const labels: Record<string, string> = {
    simulated: "simulation", error: "erreur", awaiting_approval: "validation attendue", running: "en cours",
    skipped: "ignorée", partial: "résultat partiel", blocked: "bloquée", cancelled: "annulée", canceled: "annulée",
  };
  return labels[run.status] ?? `état non classé : ${run.status}`;
}

/**
 * A deterministic rendering of already-read run records. No inference, database
 * request, tool execution, or independent verification is performed here.
 * Invalid or foreign data rejects the entire report instead of inventing zeroes.
 */
export function buildRoutineReport(
  sourceRoutine: Routine, runs: unknown[], sourceWindow: {
    since: string; until: string; truncated: boolean; startExclusive?: boolean; endExclusive?: boolean;
  },
): RoutineReport {
  if (!sourceRoutine || typeof sourceRoutine.userId !== "string" || !UUID.test(sourceRoutine.userId) ||
    !Array.isArray(runs) || runs.length > MAX_ROWS || !sourceWindow || typeof sourceWindow.truncated !== "boolean" ||
    (sourceWindow.startExclusive !== undefined && typeof sourceWindow.startExclusive !== "boolean") ||
    (sourceWindow.endExclusive !== undefined && typeof sourceWindow.endExclusive !== "boolean") ||
    (runs.length === 0 && sourceWindow.truncated)) return fail();
  let routine: Routine;
  try { routine = { ...sourceRoutine, config: normalizeRoutineInput(sourceRoutine.config) }; }
  catch { return fail(); }
  const since = timestamp(sourceWindow.since);
  const until = timestamp(sourceWindow.until);
  if (since.micros > until.micros) return fail();
  const validated = runs.map(value => parseRun(value, routine, since, until));
  if (new Set(validated.map(run => run.id.toLowerCase())).size !== validated.length) return fail();
  // A task can finish between the captured window end and the DB read. Its
  // current terminal record belongs to the next window, not a fabricated
  // earlier state. Validate ownership/shape first, then defer it as a whole.
  const deferred = validated.filter(run => run.recency > until.micros || (sourceWindow.endExclusive && run.recency === until.micros)).length;
  const parsed = validated.filter(run => (sourceWindow.endExclusive ? run.recency < until.micros : run.recency <= until.micros) &&
    (!sourceWindow.startExclusive || run.recency > since.micros));
  if (parsed.length === 0 && sourceWindow.truncated) return fail();
  const counts: RoutineReportCounts = { success: 0, error: 0, awaiting: 0, simulated: 0, running: 0, skipped: 0, other: 0 };
  for (const run of parsed) counts[category(run)]++;
  parsed.sort((a, b) => priority(a) - priority(b) || (a.recency > b.recency ? -1 : a.recency < b.recency ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const selected = parsed.slice(0, ITEM_LIMIT[routine.config.length]);
  const date = new Intl.DateTimeFormat("fr-FR", { timeZone: routine.config.schedule.timezone, year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const title = `${routine.config.name} — bilan IAO`;
  const lines = [
    title,
    `Période : du ${date.format(new Date(since.iso))} au ${date.format(new Date(until.iso))} (${routine.config.schedule.timezone}).`,
    `Consigne de présentation : ${shorten(routine.config.instruction, 800, "… [consigne abrégée]")}`,
    parsed.length === 0 ? deferred === 0 ? "Aucune activité enregistrée dans cette fenêtre."
      : "Aucun cycle inclus dans ce bilan : les cycles à partir de la clôture sont reportés au prochain bilan." :
      `${parsed.length} cycle(s) reçu(s) : ${counts.success} exécution(s) signalée(s) réussie(s), ${counts.error} en erreur, ` +
      `${counts.awaiting} en attente de validation, ${counts.simulated} simulation(s), ${counts.running} en cours, ` +
      `${counts.skipped} ignoré(s), ${counts.other} autre(s) état(s).`,
  ];
  if (parsed.length > 0 && deferred > 0) {
    lines.push(`${deferred} cycle(s) à partir de la clôture sont reportés au prochain bilan.`);
  }
  if (sourceWindow.truncated) lines.push("La sélection des données est limitée : ce bilan ne couvre pas toute l’activité de la période.");
  const suffix = "Les états et résumés proviennent du journal d’exécution. Ils ne constituent pas une vérification indépendante des résultats.";
  const prefix = lines.join("\n\n");
  const wrappers = selected.map(run => {
    const tags = [run.mode === "simulation" ? "mode simulation" : "mode réel", ...(run.mock ? ["décision simulée"] : [])].join(", ");
    const ending = run.finishedAt ? `fin ${date.format(new Date(run.finishedAt))}` : `début ${date.format(new Date(run.startedAt))} ; fin non renseignée`;
    return `• ${run.agentType} — ${label(run)} (${tags} ; ${ending}) : `;
  });
  const items: RoutineReportItem[] = selected.map(run => ({
    id: run.id, agentType: run.agentType, status: run.status, mode: run.mode, mock: run.mock,
    summary: run.summary, finishedAt: run.finishedAt,
  }));
  const bodyRows: string[] = [];
  // Reserve the complete caveat and omission notice before adding whole rows.
  let remaining = ROUTINE_REPORT_MAX_CHARS - prefix.length - suffix.length - 200;
  for (let index = 0; index < items.length; index++) {
    const row = wrappers[index] + shorten(items[index].summary, BODY_SUMMARY_LIMIT[routine.config.length]);
    if (row.length + 2 > remaining) break;
    bodyRows.push(row);
    remaining -= row.length + 2;
  }
  const notice = bodyRows.length < parsed.length
    ? [`Message abrégé : ${bodyRows.length} élément(s) détaillé(s) sur ${parsed.length} cycles reçus ; les compteurs incluent tous les cycles reçus.`] : [];
  const body = [prefix, ...bodyRows, ...notice, suffix].join("\n\n");
  if (body.length > ROUTINE_REPORT_MAX_CHARS) return fail();
  return { title, body, sourceCount: parsed.length, hasNewActivity: parsed.length > 0,
    window: { since: since.iso, until: until.iso }, items, counts, truncated: sourceWindow.truncated };
}
