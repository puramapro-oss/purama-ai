import type { AnyToolDefinition, ToolInputSchema } from "../engine/types.js";
import { validateProgrammaticToolParams } from "../engine/tool-input.js";

/** Domain routes are existing products, not new applications or tool permissions. */
export const RESOLUTION_DOMAINS = {
  A: { label: "Démarches et accès aux droits", routes: ["NIDHI", "Dossier sans oubli", "Courrier en clair", "Démarche à deux"] },
  B: { label: "Budget et aides", routes: ["NIDHI", "Ma semaine en chiffres", "Coût complet", "Abonnements au clair"] },
  C: { label: "Achats assurances et restitutions", routes: ["NIDHI", "marketplace", "SAV", "Facture expliquée"] },
  D: { label: "Logement et entretien", routes: ["Maison documentée", "Réparons", "Notice retrouvée", "Entretien au bon moment", "Passage de vie"] },
  E: { label: "Soins et aidants", routes: ["Relais entre aidants", "Répit logistique", "Accompagné au rendez-vous"] },
  F: { label: "Famille et transitions", routes: ["Passage de vie", "Maison partagée", "Quotidien après un choc", "Souvenirs vivants"] },
  G: { label: "Effort et accessibilité", routes: ["Journée souple", "Mon profil de confort", "Parler avec des cartes", "Mode téléphone partagé", "Participer sans smartphone"] },
  H: { label: "Emploi et activité", routes: ["VIDA JOB", "KARYA", "Formation", "Mon Projet"] },
  I: { label: "Apprentissage création et lien", routes: ["Formation", "Assemblée", "SUTRA", "DreamForge", "événements et cercles"] },
  J: { label: "Accès numérique et conservation", routes: ["RAKSHA", "ONE ID", "VAJRA", "mémoire", "documents et sauvegardes"] },
  K: { label: "Mobilité et territoire", routes: ["YANA", "Passage de vie", "ressources locales", "Country Packs"] },
  L: { label: "Protection et crise", routes: ["RAKSHA", "Faire la paix", "Aide de crise coordonnée"] },
  M: { label: "Alimentation et besoins essentiels", routes: ["Placard en repas", "Repas qui arrivent", "NANO", "entraide et distribution"] },
  N: { label: "Animaux nature et ressources locales", routes: ["projets animaux et nature", "KARYA", "NANO", "ressources partagées"] },
} as const;

type DomainId = keyof typeof RESOLUTION_DOMAINS;
type Stage = "prepared" | "transmitted" | "accepted" | "performed";
type SourceKind = "requirement" | "satisfaction" | "alternative" | "acceptance" | "activation" | "correction" | "transmission" | "responsibility" | "performance" | "authorization";
interface SourceReference {
  id: string; caseId: string; snapshotRevision: number; subjectId: string;
  kind: SourceKind; reference: string; observedAt: string;
}
interface Alternative {
  id: string; prerequisiteId: string; state: "proposed" | "reported_accepted" | "reported_refused";
  sourceIds: string[]; acceptanceSourceIds: string[];
}
interface Requirement {
  id: string; state: "unknown" | "reported_satisfied" | "reported_refused" | "conflicting";
  basis: "attested_rule" | "interlocutor_request" | "hypothesis";
  requires: string[]; sourceIds: string[]; satisfactionSourceIds: string[]; alternatives: Alternative[];
}
interface Transition {
  id: string; timeZone: string; windowStart?: string; windowEnd?: string;
  periods: Array<{ id: string; start?: string; end?: string; stage: "desired" | "requested" | "agreed" | "reported_active" | "cancelled"; sourceIds: string[] }>;
}
interface Effort {
  chosenMinutes?: 2 | 10 | 25; paused: boolean; maxCalls?: number; maxTrips?: number;
  steps: Array<{ id: string; state: "pending" | "completed"; estimatedMinutes?: number; calls?: number; trips?: number }>;
}
interface Correction {
  id: string; factId: string; fromVersion: number; toVersion: number; expectedVersion: number; currentVersion: number;
  assertion: "suspected" | "reported_established"; sourceIds: string[];
  consequences: Array<{ id: string; version: number; dependsOn: string[]; stage: "draft" | "transmitted" | "committed" | "performed" }>;
}
interface EpisodeIdentity {
  episodeId: string; beneficiaryId: string; objectId: string; periodId: string; engagementId: string; territory: string;
  operationId: string; payloadHash: string;
}
interface Occurrence {
  requested: "new_episode" | "reopen" | "technical_retry"; current: EpisodeIdentity;
  previous?: EpisodeIdentity & { state: "open" | "closed" | "refused"; effect: "none" | "uncertain" | "executed"; attempts: number };
  attemptLimit: number; changeReason?: string; revoked: boolean;
}
interface Handoff {
  id: string; recipientId: string; recipientState: "unknown" | "reported_resolved"; role: string; channel: string;
  actionId: string; dataIds: string[]; requestedStage: Stage; conflicting: boolean;
  transmissionSourceIds: string[]; acceptanceSourceIds: string[]; performanceSourceIds: string[];
  authorization?: { status: "unknown" | "reported_valid" | "revoked" | "expired"; caseId: string; actorId: string;
    actionIds: string[]; dataIds: string[]; expiresAt?: string; sourceIds: string[] };
}
export interface ResolutionInput {
  caseId: string; snapshotRevision: number; asOf: string; domains: DomainId[]; sources: SourceReference[];
  dependencies?: Requirement[]; transitions?: Transition[]; effort?: Effort;
  corrections?: Correction[]; occurrence?: Occurrence; handoffs?: Handoff[];
}

type Schema = Record<string, unknown>;
const identifier: Schema = { type: "string", minLength: 1, maxLength: 160 };
const date: Schema = { type: "string", minLength: 20, maxLength: 35 };
const integer: Schema = { type: "integer", minimum: 0, maximum: 1_000_000 };
const revision: Schema = { type: "integer", minimum: 1, maximum: 1_000_000 };
const enumeration = (values: readonly string[]): Schema => ({ type: "string", enum: values });
const array = (items: Schema, maxItems = 32): Schema => ({ type: "array", items, minItems: 0, maxItems });
const ids: Schema = { ...array(identifier), uniqueItems: true };
const object = (properties: Record<string, Schema>, optional: readonly string[] = []): ToolInputSchema & Schema => ({
  type: "object", properties, required: Object.keys(properties).filter(key => !optional.includes(key)), additionalProperties: false,
});
const identityProperties = {
  episodeId: identifier, beneficiaryId: identifier, objectId: identifier, periodId: identifier,
  engagementId: identifier, territory: identifier, operationId: identifier, payloadHash: identifier,
};

/** The existing strict programmatic validator enforces nested bounds, plain data and 64KiB. */
export const RESOLUTION_INPUT_SCHEMA = object({
  caseId: identifier, snapshotRevision: revision, asOf: date,
  domains: { ...array(enumeration(Object.keys(RESOLUTION_DOMAINS)), 14), uniqueItems: true },
  sources: array(object({
    id: identifier, caseId: identifier, snapshotRevision: revision, subjectId: identifier,
    kind: enumeration(["requirement", "satisfaction", "alternative", "acceptance", "activation", "correction", "transmission", "responsibility", "performance", "authorization"]),
    reference: { type: "string", minLength: 1, maxLength: 500 }, observedAt: date,
  }), 128),
  dependencies: array(object({
    id: identifier, state: enumeration(["unknown", "reported_satisfied", "reported_refused", "conflicting"]),
    basis: enumeration(["attested_rule", "interlocutor_request", "hypothesis"]), requires: ids, sourceIds: ids, satisfactionSourceIds: ids,
    alternatives: array(object({ id: identifier, prerequisiteId: identifier,
      state: enumeration(["proposed", "reported_accepted", "reported_refused"]), sourceIds: ids, acceptanceSourceIds: ids }), 8),
  })),
  transitions: array(object({
    id: identifier, timeZone: identifier, windowStart: date, windowEnd: date,
    periods: array(object({ id: identifier, start: date, end: date,
      stage: enumeration(["desired", "requested", "agreed", "reported_active", "cancelled"]), sourceIds: ids }, ["start", "end"])),
  }, ["windowStart", "windowEnd"]), 16),
  effort: object({ chosenMinutes: { type: "integer", enum: [2, 10, 25] }, paused: { type: "boolean" }, maxCalls: integer, maxTrips: integer,
    steps: array(object({ id: identifier, state: enumeration(["pending", "completed"]), estimatedMinutes: integer, calls: integer, trips: integer }, ["estimatedMinutes", "calls", "trips"])),
  }, ["chosenMinutes", "maxCalls", "maxTrips"]),
  corrections: array(object({ id: identifier, factId: identifier, fromVersion: revision, toVersion: revision, expectedVersion: revision, currentVersion: revision,
    assertion: enumeration(["suspected", "reported_established"]), sourceIds: ids,
    consequences: array(object({ id: identifier, version: revision, dependsOn: ids, stage: enumeration(["draft", "transmitted", "committed", "performed"]) })),
  }), 16),
  occurrence: object({ requested: enumeration(["new_episode", "reopen", "technical_retry"]), current: object(identityProperties),
    previous: object({ ...identityProperties, state: enumeration(["open", "closed", "refused"]), effect: enumeration(["none", "uncertain", "executed"]), attempts: integer }),
    attemptLimit: { type: "integer", minimum: 1, maximum: 20 }, changeReason: { type: "string", minLength: 1, maxLength: 500 }, revoked: { type: "boolean" },
  }, ["previous", "changeReason"]),
  handoffs: array(object({ id: identifier, recipientId: identifier, recipientState: enumeration(["unknown", "reported_resolved"]), role: identifier, channel: identifier,
    actionId: identifier, dataIds: ids, requestedStage: enumeration(["prepared", "transmitted", "accepted", "performed"]), conflicting: { type: "boolean" },
    transmissionSourceIds: ids, acceptanceSourceIds: ids, performanceSourceIds: ids,
    authorization: object({ status: enumeration(["unknown", "reported_valid", "revoked", "expired"]), caseId: identifier, actorId: identifier,
      actionIds: ids, dataIds: ids, expiresAt: date, sourceIds: ids }, ["expiresAt"]),
  }, ["authorization"])),
}, ["dependencies", "transitions", "effort", "corrections", "occurrence", "handoffs"]) as ToolInputSchema;

const validationDescriptor: AnyToolDefinition = {
  name: "qualify_resolution", sensitive: false, description: "Qualification locale des données fournies.",
  inputSchema: RESOLUTION_INPUT_SCHEMA, execute: async () => undefined,
};

/** Reject rollover dates, missing offsets and non-finite timestamps. Unknown is never epoch zero. */
function instant(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, y, m, d, h, min, sec, fraction, zone] = match;
  const year = Number(y), month = Number(m), day = Number(d), hour = Number(h), minute = Number(min), second = Number(sec);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return undefined;
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, Number((fraction ?? "").padEnd(3, "0")));
  if (new Date(wall).getUTCDate() !== day) return undefined;
  let offset = 0;
  if (zone !== "Z") {
    const hours = Number(zone.slice(1, 3)), minutes = Number(zone.slice(4, 6));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return undefined;
    offset = (hours * 60 + minutes) * 60_000 * (zone[0] === "+" ? 1 : -1);
  }
  return wall - offset;
}

function assertUnique(items: readonly { id: string }[]): void {
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error("Identifiants de qualification ambigus.");
}

type References = (ids: string[], subjectId: string, kind: SourceKind) => boolean;

/** SCCs describe a business graph only. They are never submitted as a CHEF execution DAG. */
function cycles(nodes: Requirement[], edges: Map<string, string[]>): string[][] {
  const index = new Map<string, number>(), low = new Map<string, number>();
  const stack: string[] = [], onStack = new Set<string>(), result: string[][] = [];
  let next = 0;
  const visit = (id: string): void => {
    index.set(id, next); low.set(id, next++); stack.push(id); onStack.add(id);
    for (const other of edges.get(id) ?? []) {
      if (!edges.has(other)) continue;
      if (!index.has(other)) { visit(other); low.set(id, Math.min(low.get(id)!, low.get(other)!)); }
      else if (onStack.has(other)) low.set(id, Math.min(low.get(id)!, index.get(other)!));
    }
    if (low.get(id) !== index.get(id)) return;
    const component: string[] = [];
    let current: string;
    do { current = stack.pop()!; onStack.delete(current); component.push(current); } while (current !== id);
    if (component.length > 1 || edges.get(id)?.includes(id)) result.push(component.sort());
  };
  for (const node of nodes) if (!index.has(node.id)) visit(node.id);
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}

function qualifyDependencies(nodes: Requirement[], references: References) {
  assertUnique(nodes);
  // A source identifies its subject within this snapshot, not its array position.
  assertUnique(nodes.flatMap(node => node.alternatives));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const effective = new Map<string, string[]>();
  const alternatives: Array<{ requirementId: string; alternativeId: string; prerequisiteId: string; assessment: string }> = [];
  const requirementAssessments = nodes.map(node => {
    assertUnique(node.alternatives);
    const waived = new Set<string>();
    for (const alternative of node.alternatives) {
      let assessment = "pending_source";
      if (!node.requires.includes(alternative.prerequisiteId)) assessment = "unrelated_prerequisite";
      else if (alternative.state === "reported_refused") assessment = "reported_refused";
      else if (references(alternative.sourceIds, alternative.id, "alternative")) {
        assessment = alternative.state === "reported_accepted" && references(alternative.acceptanceSourceIds, alternative.id, "acceptance")
          ? "candidate_under_supplied_references" : "pending_acceptance";
      }
      if (assessment === "candidate_under_supplied_references") waived.add(alternative.prerequisiteId);
      alternatives.push({ requirementId: node.id, alternativeId: alternative.id, prerequisiteId: alternative.prerequisiteId, assessment });
    }
    effective.set(node.id, node.requires.filter(id => !waived.has(id)));
    return { id: node.id, reportedBasis: node.basis, sourceReferenced: references(node.sourceIds, node.id, "requirement"),
      state: node.state, unknownPrerequisites: node.requires.filter(id => !byId.has(id)) };
  });
  const satisfied = (id: string): boolean => {
    const node = byId.get(id);
    return node?.state === "reported_satisfied" && references(node.satisfactionSourceIds, id, "satisfaction");
  };
  return {
    originalCycles: cycles(nodes, new Map(nodes.map(node => [node.id, node.requires]))), remainingCycles: cycles(nodes, effective),
    requirements: requirementAssessments, alternatives,
    nextCandidateIds: nodes.filter(node => node.state === "unknown" && node.basis !== "hypothesis"
      && references(node.sourceIds, node.id, "requirement")
      && (effective.get(node.id) ?? []).every(satisfied)).map(node => node.id),
    executionPlanCreated: false,
  };
}

type Interval = { start: string; end: string };
function qualifyTransition(transition: Transition, references: References) {
  assertUnique(transition.periods);
  let validTimeZone = true;
  try { new Intl.DateTimeFormat("en", { timeZone: transition.timeZone }).format(0); } catch { validTimeZone = false; }
  const start = instant(transition.windowStart), end = instant(transition.windowEnd);
  const windowKnown = validTimeZone && start !== undefined && end !== undefined && start < end;
  const unknownPeriodIds: string[] = [], excludedPeriodIds: string[] = [];
  const intervals: Array<[number, number]> = [];
  for (const period of transition.periods) {
    const from = instant(period.start), to = instant(period.end);
    if (from === undefined || to === undefined || from >= to) unknownPeriodIds.push(period.id);
    if (period.stage !== "reported_active" || !references(period.sourceIds, period.id, "activation")) {
      excludedPeriodIds.push(period.id); continue;
    }
    if (windowKnown && from !== undefined && to !== undefined && from < to) {
      const left = Math.max(start!, from), right = Math.min(end!, to);
      if (left < right) intervals.push([left, right]);
    }
  }
  const gaps: Interval[] = [], overlaps: Interval[] = [];
  if (windowKnown) {
    const boundaries = [...new Set([start!, end!, ...intervals.flat()])].sort((a, b) => a - b);
    for (let i = 0; i < boundaries.length - 1; i++) {
      const left = boundaries[i], right = boundaries[i + 1];
      const count = intervals.filter(([a, b]) => a <= left && b >= right).length;
      const list = count === 0 ? gaps : count > 1 ? overlaps : undefined;
      if (!list) continue;
      const a = new Date(left).toISOString(), b = new Date(right).toISOString();
      const previous = list.at(-1);
      if (previous?.end === a) previous.end = b; else list.push({ start: a, end: b });
    }
  }
  return { id: transition.id, assessment: windowKnown ? "calculated_from_supplied_claims" : "unknown_window",
    timeZone: transition.timeZone, gaps: windowKnown ? gaps : null, overlaps: windowKnown ? overlaps : null,
    unknownPeriodIds, excludedPeriodIds, actualCoverageVerified: false, previousServiceClosureAuthorized: false };
}

function qualifyEffort(effort: Effort) {
  assertUnique(effort.steps);
  const completedStepIds = effort.steps.filter(step => step.state === "completed").map(step => step.id);
  const assessments = effort.steps.filter(step => step.state === "pending").map(step => {
    const reasons: string[] = [];
    if (effort.chosenMinutes !== undefined) {
      if (step.estimatedMinutes === undefined) reasons.push("duration_unknown");
      else if (step.estimatedMinutes > effort.chosenMinutes) reasons.push("duration_exceeds_choice");
    }
    for (const [limit, amount, name] of [[effort.maxCalls, step.calls, "calls"], [effort.maxTrips, step.trips, "trips"]] as const) {
      if (limit !== undefined && (amount === undefined || amount > limit)) reasons.push(`${name}_${amount === undefined ? "unknown" : "exceed_choice"}`);
    }
    return { id: step.id, reasons };
  });
  return { source: "user_declared" as const, chosenMinutes: effort.chosenMinutes ?? null, paused: effort.paused,
    nextStepId: effort.paused ? null : assessments.find(step => step.reasons.length === 0)?.id ?? null,
    assessments, completedStepIds, authorizationChanged: false, healthInferencePerformed: false, remindersCreated: false };
}

function qualifyCorrection(correction: Correction, references: References) {
  assertUnique(correction.consequences);
  if (correction.toVersion <= correction.fromVersion || correction.consequences.some(item => item.id === correction.factId)) {
    throw new Error("Versions ou dépendances de correction incohérentes.");
  }
  const established = correction.assertion === "reported_established" && references(correction.sourceIds, correction.id, "correction");
  const conflict = correction.currentVersion !== correction.expectedVersion || correction.expectedVersion !== correction.fromVersion;
  const affected = new Set([correction.factId]);
  const known = new Set([correction.factId, ...correction.consequences.map(item => item.id)]);
  const unresolvedDependencies = correction.consequences.map(item => ({ id: item.id, missingIds: item.dependsOn.filter(id => !known.has(id)) }))
    .filter(item => item.missingIds.length > 0);
  const unknown = new Set(unresolvedDependencies.map(item => item.id));
  for (let pass = 0; pass < correction.consequences.length; pass++) {
    for (const item of correction.consequences) {
      if (item.dependsOn.some(id => affected.has(id))) affected.add(item.id);
      if (item.dependsOn.some(id => unknown.has(id))) unknown.add(item.id);
    }
  }
  return { id: correction.id, assessment: conflict ? "version_conflict" : established ? "referenced_correction_claim" : "correction_unestablished",
    fromVersion: correction.fromVersion, proposedVersion: correction.toVersion,
    consequences: correction.consequences.filter(item => affected.has(item.id)).map(item => ({ id: item.id, version: item.version, stage: item.stage,
      next: conflict ? "reconcile_versions" : !established ? "establish_correction" : item.stage === "draft" ? "prepare_local_revision"
        : item.stage === "transmitted" ? "prepare_external_rectification" : "reconcile_existing_effect",
    })), notLinkedBySuppliedGraphIds: correction.consequences.filter(item => !affected.has(item.id)).map(item => item.id),
    unresolvedDependencies, impactUnknownIds: correction.consequences.filter(item => unknown.has(item.id)).map(item => item.id),
    impactAssessmentComplete: false,
    modificationsPerformed: 0, externalRectificationsSent: 0, repaired: false };
}

function qualifyOccurrence(occurrence: Occurrence) {
  const { current, previous } = occurrence;
  const identityFields = ["beneficiaryId", "objectId", "periodId", "engagementId", "territory"] as const;
  const differences = previous ? identityFields.filter(key => current[key] !== previous[key]) : [];
  const sameOperation = previous !== undefined && current.operationId === previous.operationId;
  let assessment: string;
  if (occurrence.revoked) assessment = "revoked_no_retry";
  else if (!previous) assessment = occurrence.requested === "new_episode" ? "new_episode_candidate" : "previous_episode_unknown";
  // Relabelling the business episode cannot clear an operation's uncertain or completed effect.
  else if (sameOperation && current.payloadHash !== previous.payloadHash) assessment = "operation_identity_conflict";
  else if (previous.effect === "uncertain" && (sameOperation || differences.length === 0)) assessment = "reconcile_unknown_effect";
  else if (sameOperation && previous.effect === "executed") assessment = "already_performed_no_replay";
  else if (occurrence.requested === "new_episode") assessment = current.episodeId === previous.episodeId ? "possible_duplicate_episode"
    : sameOperation ? "operation_identity_conflict" : "new_episode_candidate";
  else if (differences.length > 0) assessment = "different_context_do_not_merge";
  else if (current.episodeId !== previous.episodeId) assessment = "different_episode_do_not_replay";
  else if (occurrence.requested === "reopen") assessment = previous.state === "closed" && occurrence.changeReason ? "reopening_candidate" : "reopening_not_justified";
  else if (current.operationId !== previous.operationId || current.payloadHash !== previous.payloadHash) assessment = "operation_identity_conflict";
  else if (previous.effect === "uncertain") assessment = "reconcile_unknown_effect";
  else if (previous.effect === "executed") assessment = "already_performed_no_replay";
  else if (previous.state === "closed") assessment = "closed_episode_requires_reopening";
  else if (previous.attempts >= occurrence.attemptLimit) assessment = "attempt_limit_reached";
  else if (previous.state === "refused") assessment = "refusal_requires_changed_business_request";
  else if (!occurrence.changeReason) assessment = "retry_not_justified";
  else assessment = "technical_replay_candidate";
  return { assessment, differences, episodeId: current.episodeId, operationId: current.operationId,
    previousEffect: previous?.effect ?? null, reconciliationRequired: previous?.effect === "uncertain",
    executionAuthorized: false, recordsMerged: false, attemptsCreated: 0, scheduleCreated: false };
}

function qualifyHandoff(handoff: Handoff, input: ResolutionInput, references: References) {
  const reasons: string[] = [];
  const stages: Stage[] = ["prepared", "transmitted", "accepted", "performed"];
  const claims: Array<[Stage, string[], SourceKind]> = [
    ["transmitted", handoff.transmissionSourceIds, "transmission"],
    ["accepted", handoff.acceptanceSourceIds, "responsibility"],
    ["performed", handoff.performanceSourceIds, "performance"],
  ];
  let referencedStage: Stage = "prepared";
  for (const [stage, idsForStage, kind] of claims) {
    if (stages.indexOf(stage) > stages.indexOf(handoff.requestedStage)) break;
    if (!references(idsForStage, handoff.id, kind)) { reasons.push(`missing_${stage}_reference`); break; }
    // observedAt is the consultation/receipt time of a reference, not the event time.
    referencedStage = stage;
  }
  if (handoff.conflicting) { reasons.push("conflicting_claims"); referencedStage = "prepared"; }
  if (handoff.recipientState !== "reported_resolved") reasons.push("recipient_unresolved");
  const authority = handoff.authorization;
  if (!authority || authority.status === "unknown") reasons.push("authorization_missing");
  else if (authority.status === "revoked" || authority.status === "expired") reasons.push(`authorization_${authority.status}`);
  else {
    if (authority.caseId !== input.caseId || authority.actorId !== handoff.recipientId
      || !authority.actionIds.includes(handoff.actionId) || handoff.dataIds.some(id => !authority.dataIds.includes(id))) reasons.push("authorization_out_of_scope");
    const expiry = instant(authority.expiresAt);
    if (expiry === undefined) reasons.push("authorization_expiry_unknown");
    else if (expiry <= instant(input.asOf)!) reasons.push("authorization_expired");
    if (!references(authority.sourceIds, handoff.id, "authorization")) reasons.push("authorization_reference_missing");
  }
  return { id: handoff.id, requestedStage: handoff.requestedStage, referencedStage,
    stageReferenceIds: { transmitted: [...handoff.transmissionSourceIds], accepted: [...handoff.acceptanceSourceIds], performed: [...handoff.performanceSourceIds] },
    stageOrderVerified: false, externalStageVerified: false, futureSharing: reasons.some(reason => reason.startsWith("authorization_") || reason === "recipient_unresolved" || reason === "conflicting_claims")
      ? "blocked_pending_qualification" : "requires_trusted_authorization", reasons,
    roleGrantsAuthority: false, permissionGranted: false, transmittedByThisTool: false };
}

/** Pure, bounded qualification of a caller-provided snapshot. No storage, network or authority lookup. */
export function qualifyResolution(value: unknown) {
  validateProgrammaticToolParams(validationDescriptor, value);
  const input = value as unknown as ResolutionInput;
  const asOf = instant(input.asOf);
  if (asOf === undefined) throw new Error("Date de qualification invalide : date et décalage horaire requis.");
  assertUnique(input.sources);
  const sourceMap = new Map(input.sources.map(source => [source.id, source]));
  const rejectedSourceIds = input.sources.filter(source => source.caseId !== input.caseId || source.snapshotRevision !== input.snapshotRevision
    || instant(source.observedAt) === undefined || instant(source.observedAt)! > asOf || !source.reference.trim()).map(source => source.id);
  const rejected = new Set(rejectedSourceIds);
  const references: References = (sourceIds, subjectId, kind) => sourceIds.length > 0 && sourceIds.every(id => {
    const source = sourceMap.get(id);
    return source !== undefined && !rejected.has(id) && source.subjectId === subjectId && source.kind === kind;
  });
  assertUnique(input.transitions ?? []); assertUnique(input.corrections ?? []); assertUnique(input.handoffs ?? []);
  assertUnique((input.transitions ?? []).flatMap(transition => transition.periods));
  return {
    ok: true, status: "preparation" as const, qualificationOnly: true, caseId: input.caseId, snapshotRevision: input.snapshotRevision, asOf: input.asOf,
    provenance: "caller_supplied_snapshot" as const, externalFactsVerified: false, permissionsGranted: false, externalActionsPerformed: 0,
    rejectedSourceIds,
    // Traces keep metadata only: retain the bounded, unauthenticated references
    // in the private product result, without sharing mutable caller objects.
    suppliedReferences: input.sources.map(source => ({ ...source })),
    domains: input.domains.map(id => ({ id, label: RESOLUTION_DOMAINS[id].label, routes: [...RESOLUTION_DOMAINS[id].routes], serviceAvailability: "not_qualified",
      ...(id === "N" ? { ownership: "precise_business_owner_required" } : {}) })),
    dependencies: input.dependencies ? qualifyDependencies(input.dependencies, references) : null,
    transitions: input.transitions?.map(transition => qualifyTransition(transition, references)) ?? null,
    effort: input.effort ? qualifyEffort(input.effort) : null,
    corrections: input.corrections?.map(correction => qualifyCorrection(correction, references)) ?? null,
    occurrence: input.occurrence ? qualifyOccurrence(input.occurrence) : null,
    handoffs: input.handoffs?.map(handoff => qualifyHandoff(handoff, input, references)) ?? null,
  };
}

export type ResolutionQualification = ReturnType<typeof qualifyResolution>;
