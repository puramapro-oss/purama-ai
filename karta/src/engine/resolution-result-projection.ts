import { RESOLUTION_DOMAINS } from "../lib/resolution-qualification.js";
import {
  parseResolutionPrivatePayload, RESOLUTION_REPORT_PROVENANCE, RESOLUTION_REPORT_SECTIONS,
  type ResolutionReportSection,
} from "../knowledge/private-result-view.js";
import type { PrivateToolResultPayload } from "./private-tool-results.js";

type Row = Record<string, unknown>;
const invalid = (): never => { throw new Error("Qualification privée invalide."); };
function row(value: unknown, keys: readonly string[]): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return invalid();
  return value as Row;
}
function list(value: unknown, max = 32): unknown[] { return Array.isArray(value) && value.length <= max ? value : invalid(); }
function text(value: unknown, max = 160): string {
  // Supplied strings use JSON Schema's code-point limits, including astral text.
  // Generated summaries/items keep their separate UTF-16 and UTF-8 envelope bounds.
  return typeof value === "string" && value.length > 0 && [...value].length <= max
    && !value.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(value) ? value : invalid();
}
function integer(value: unknown, min = 1, max = 1_000_000): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : invalid();
}
function boolean(value: unknown): boolean { return typeof value === "boolean" ? value : invalid(); }
function fixed(value: unknown, expected: unknown): void { if (value !== expected) invalid(); }
function label(value: unknown, labels: Readonly<Record<string, string>>): string {
  return typeof value === "string" && Object.hasOwn(labels, value) ? labels[value] : invalid();
}
// Quote untrusted identifiers: embedded newlines cannot masquerade as report headings.
const id = (value: unknown): string => JSON.stringify(text(value));
const ids = (value: unknown, max = 32): string => list(value, max).map(id).join(", ") || "aucun identifiant fourni";
const stage = { prepared: "préparée", transmitted: "transmise selon les références fournies", accepted: "acceptée selon les références fournies", performed: "réalisée selon les références fournies" };

function dependencies(value: unknown): Pick<ResolutionReportSection, "summary" | "items"> {
  const d = row(value, ["originalCycles", "remainingCycles", "requirements", "alternatives", "nextCandidateIds", "executionPlanCreated"]);
  fixed(d.executionPlanCreated, false);
  const requirements = list(d.requirements), alternatives = list(d.alternatives, 256);
  const original = list(d.originalCycles), remaining = list(d.remainingCycles);
  const items: string[] = [];
  for (const [groups, title] of [[original, "initialement"], [remaining, "après examen des alternatives fournies"]] as const) {
    for (const group of groups) items.push(`Groupe de prérequis interdépendants ${title} : ${ids(group)}. Ce groupe ne décrit pas un ordre d’exécution.`);
  }
  for (const entry of requirements) {
    const r = row(entry, ["id", "reportedBasis", "sourceReferenced", "state", "unknownPrerequisites"]);
    items.push(`Prérequis ${id(r.id)} : ${label(r.state, { unknown: "état inconnu", reported_satisfied: "satisfaction déclarée", reported_refused: "refus déclaré", conflicting: "affirmations contradictoires" })} ; base déclarée : ${label(r.reportedBasis, { attested_rule: "règle déclarée attestée", interlocutor_request: "demande d’un interlocuteur", hypothesis: "hypothèse" })} ; référence fournie correspondante : ${boolean(r.sourceReferenced) ? "présente, non authentifiée" : "absente ou non retenue"} ; prérequis inconnus : ${ids(r.unknownPrerequisites)}.`);
  }
  for (const entry of alternatives) {
    const a = row(entry, ["requirementId", "alternativeId", "prerequisiteId", "assessment"]);
    items.push(`Alternative ${id(a.alternativeId)}, pour ${id(a.requirementId)} et le prérequis ${id(a.prerequisiteId)} : ${label(a.assessment, {
      pending_source: "référence manquante ou non retenue", unrelated_prerequisite: "prérequis sans lien dans le graphe fourni", reported_refused: "refus déclaré",
      candidate_under_supplied_references: "candidate au regard des références fournies, sans validation externe", pending_acceptance: "acceptation à établir",
    })}.`);
  }
  items.push(`Prochaines candidates à examiner : ${ids(d.nextCandidateIds)}. Aucun plan d’exécution créé.`);
  return { summary: `${requirements.length} prérequis, ${alternatives.length} alternatives ; ${original.length} groupe(s) interdépendant(s) initialement, ${remaining.length} restant(s). Les affirmations et références restent non vérifiées.`, items };
}

function transitions(value: unknown): Pick<ResolutionReportSection, "summary" | "items"> {
  const entries = list(value, 16), items: string[] = [];
  for (const entry of entries) {
    const t = row(entry, ["id", "assessment", "timeZone", "gaps", "overlaps", "unknownPeriodIds", "excludedPeriodIds", "actualCoverageVerified", "previousServiceClosureAuthorized"]);
    fixed(t.actualCoverageVerified, false); fixed(t.previousServiceClosureAuthorized, false);
    const assessment = label(t.assessment, { calculated_from_supplied_claims: "intervalles calculés à partir des affirmations fournies", unknown_window: "fenêtre temporelle inconnue ou non interprétable" });
    items.push(`Transition ${id(t.id)} : ${assessment} ; fuseau déclaré : ${id(t.timeZone)}.`);
    for (const [key, title] of [["gaps", "Interruption possible"], ["overlaps", "Chevauchement possible"]] as const) {
      if (t[key] === null) {
        fixed(t.assessment, "unknown_window"); items.push(`${title} pour ${id(t.id)} : inconnu, aucun intervalle calculable.`);
      } else {
        fixed(t.assessment, "calculated_from_supplied_claims");
        const intervals = list(t[key], 65);
        if (!intervals.length) items.push(`${title} pour ${id(t.id)} : aucun intervalle dans le calcul fourni ; la couverture réelle reste non vérifiée.`);
        for (const interval of intervals) {
          const range = row(interval, ["start", "end"]);
          const start = text(range.start, 35), end = text(range.end, 35);
          if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) >= Date.parse(end)) invalid();
          items.push(`${title} pour ${id(t.id)} : du ${start} au ${end}.`);
        }
      }
    }
    items.push(`Transition ${id(t.id)} : périodes inconnues : ${ids(t.unknownPeriodIds)} ; périodes exclues du calcul : ${ids(t.excludedPeriodIds)}. Couverture réelle non vérifiée ; fermeture du service précédent non autorisée.`);
  }
  return { summary: `${entries.length} transition(s) fournie(s). Les lacunes et chevauchements calculés ne prouvent pas la couverture réelle et n’autorisent aucune fermeture.`, items };
}

function effort(value: unknown): Pick<ResolutionReportSection, "summary" | "items"> {
  const e = row(value, ["source", "chosenMinutes", "paused", "nextStepId", "assessments", "completedStepIds", "authorizationChanged", "healthInferencePerformed", "remindersCreated"]);
  fixed(e.source, "user_declared"); fixed(e.authorizationChanged, false); fixed(e.healthInferencePerformed, false); fixed(e.remindersCreated, false);
  const paused = boolean(e.paused);
  const minutes = e.chosenMinutes === null ? "durée non renseignée" : `${integer(e.chosenMinutes, 2, 25)} minutes choisies`;
  if (e.chosenMinutes !== null && ![2, 10, 25].includes(e.chosenMinutes as number)) invalid();
  if (paused && e.nextStepId !== null) invalid();
  const items = [`Prochaine étape candidate : ${e.nextStepId === null ? "aucune proposée" : id(e.nextStepId)}.`, `Étapes déclarées terminées : ${ids(e.completedStepIds)}.`];
  for (const entry of list(e.assessments)) {
    const a = row(entry, ["id", "reasons"]);
    const reasons = list(a.reasons, 3).map(reason => label(reason, {
      duration_unknown: "durée inconnue", duration_exceeds_choice: "durée supérieure au choix déclaré", calls_unknown: "nombre d’appels inconnu",
      calls_exceed_choice: "nombre d’appels supérieur au choix déclaré", trips_unknown: "nombre de déplacements inconnu", trips_exceed_choice: "nombre de déplacements supérieur au choix déclaré",
    }));
    items.push(`Étape ${id(a.id)} : ${reasons.length ? reasons.join(" ; ") : "aucun dépassement ou inconnu détecté pour les limites renseignées"}.`);
  }
  items.push("Choix déclarés par la personne ; aucune inférence de santé, aucune autorisation modifiée et aucun rappel créé.");
  return { summary: `${minutes} ; ${paused ? "pause demandée" : "pause non demandée"}. Les contraintes non renseignées restent inconnues.`, items };
}

function corrections(value: unknown): Pick<ResolutionReportSection, "summary" | "items"> {
  const entries = list(value, 16), items: string[] = [];
  for (const entry of entries) {
    const c = row(entry, ["id", "assessment", "fromVersion", "proposedVersion", "consequences", "notLinkedBySuppliedGraphIds", "unresolvedDependencies", "impactUnknownIds", "impactAssessmentComplete", "modificationsPerformed", "externalRectificationsSent", "repaired"]);
    fixed(c.impactAssessmentComplete, false); fixed(c.modificationsPerformed, 0); fixed(c.externalRectificationsSent, 0); fixed(c.repaired, false);
    const from = integer(c.fromVersion), to = integer(c.proposedVersion); if (to <= from) invalid();
    items.push(`Correction ${id(c.id)}, version ${from} vers ${to} proposée : ${label(c.assessment, { version_conflict: "versions à rapprocher avant toute correction", referenced_correction_claim: "correction déclarée avec une référence fournie, non authentifiée", correction_unestablished: "correction à établir" })}.`);
    for (const consequence of list(c.consequences)) {
      const a = row(consequence, ["id", "version", "stage", "next"]);
      items.push(`Conséquence ${id(a.id)} de ${id(c.id)}, version ${integer(a.version)}, stade déclaré ${label(a.stage, { draft: "brouillon", transmitted: "transmis", committed: "engagé", performed: "réalisé" })} : ${label(a.next, {
        reconcile_versions: "rapprocher les versions", establish_correction: "établir la correction", prepare_local_revision: "préparer une révision locale",
        prepare_external_rectification: "préparer une rectification externe", reconcile_existing_effect: "rapprocher l’effet déjà déclaré",
      })}.`);
    }
    items.push(`Correction ${id(c.id)} : éléments sans lien établi dans le graphe fourni : ${ids(c.notLinkedBySuppliedGraphIds)}. Une absence de lien fourni ne prouve pas une absence d’impact.`);
    for (const unresolved of list(c.unresolvedDependencies)) {
      const a = row(unresolved, ["id", "missingIds"]);
      items.push(`Dépendances non résolues pour ${id(a.id)} dans ${id(c.id)} : ${ids(a.missingIds)}.`);
    }
    items.push(`Correction ${id(c.id)} : impact inconnu pour ${ids(c.impactUnknownIds)} ; étude d’impact incomplète. Modifications réalisées : 0 ; rectifications externes envoyées : 0 ; réparation non établie.`);
  }
  return { summary: `${entries.length} correction(s) examinée(s) dans le graphe fourni. Aucun document modifié, aucune rectification envoyée ; les impacts externes restent à vérifier.`, items };
}

function occurrence(value: unknown): Pick<ResolutionReportSection, "summary" | "items"> {
  const o = row(value, ["assessment", "differences", "episodeId", "operationId", "previousEffect", "reconciliationRequired", "executionAuthorized", "recordsMerged", "attemptsCreated", "scheduleCreated"]);
  fixed(o.executionAuthorized, false); fixed(o.recordsMerged, false); fixed(o.attemptsCreated, 0); fixed(o.scheduleCreated, false);
  const assessment = label(o.assessment, {
    revoked_no_retry: "reprise bloquée par une révocation déclarée", new_episode_candidate: "nouvel épisode candidat", previous_episode_unknown: "épisode précédent inconnu",
    operation_identity_conflict: "identité d’opération contradictoire", reconcile_unknown_effect: "effet inconnu à rapprocher avant toute reprise", already_performed_no_replay: "effet déjà déclaré réalisé ; aucune répétition",
    possible_duplicate_episode: "doublon d’épisode possible", different_context_do_not_merge: "contexte différent ; aucun regroupement", different_episode_do_not_replay: "épisode différent ; aucune reprise",
    reopening_candidate: "réouverture candidate", reopening_not_justified: "réouverture non justifiée", closed_episode_requires_reopening: "épisode clos nécessitant une qualification de réouverture",
    attempt_limit_reached: "limite de tentatives atteinte", refusal_requires_changed_business_request: "refus déclaré nécessitant une demande métier modifiée", retry_not_justified: "reprise non justifiée", technical_replay_candidate: "reprise technique candidate",
  });
  const differences = list(o.differences, 5).map(field => label(field, { beneficiaryId: "bénéficiaire", objectId: "objet", periodId: "période", engagementId: "engagement", territory: "territoire" }));
  const effect = o.previousEffect === null ? "inconnu, aucun épisode précédent fourni" : label(o.previousEffect, { none: "absence d’effet déclarée", uncertain: "effet incertain déclaré", executed: "effet réalisé déclaré" });
  const reconciliation = boolean(o.reconciliationRequired); fixed(reconciliation, o.previousEffect === "uncertain");
  return { summary: `${assessment}. Aucune exécution autorisée et aucune tentative créée.`, items: [
    `Épisode ${id(o.episodeId)} ; opération ${id(o.operationId)}.`, `Différences de contexte dans les données fournies : ${differences.length ? differences.join(", ") : "aucune détectée ; la présence d’un épisode précédent n’est pas garantie"}.`,
    `Effet précédent : ${effect} ; rapprochement requis : ${reconciliation ? "oui" : "non selon les données fournies"}.`,
    "Dossiers regroupés : 0 ; tentatives créées : 0 ; programmation créée : 0. Une candidature ne constitue aucune permission de rejouer.",
  ] };
}

function handoffs(value: unknown): Pick<ResolutionReportSection, "summary" | "items"> {
  const entries = list(value), items: string[] = [];
  for (const entry of entries) {
    const h = row(entry, ["id", "requestedStage", "referencedStage", "stageReferenceIds", "stageOrderVerified", "externalStageVerified", "futureSharing", "reasons", "roleGrantsAuthority", "permissionGranted", "transmittedByThisTool"]);
    for (const field of ["stageOrderVerified", "externalStageVerified", "roleGrantsAuthority", "permissionGranted", "transmittedByThisTool"]) fixed(h[field], false);
    items.push(`Passation ${id(h.id)} : stade demandé ${label(h.requestedStage, stage)} ; stade soutenu par les seules références fournies ${label(h.referencedStage, stage)}. Ordre des événements et réalisation externe non vérifiés.`);
    const refs = row(h.stageReferenceIds, ["transmitted", "accepted", "performed"]);
    items.push(`Références déclarées pour ${id(h.id)} : transmission : ${ids(refs.transmitted)} ; acceptation : ${ids(refs.accepted)} ; réalisation : ${ids(refs.performed)}. Les dates d’observation ne prouvent pas la chronologie des événements.`);
    const reasons = list(h.reasons, 12).map(reason => label(reason, {
      missing_transmitted_reference: "référence de transmission absente ou non retenue", missing_accepted_reference: "référence d’acceptation absente ou non retenue", missing_performed_reference: "référence de réalisation absente ou non retenue",
      conflicting_claims: "affirmations contradictoires", recipient_unresolved: "destinataire non résolu", authorization_missing: "autorisation manquante", authorization_revoked: "autorisation déclarée révoquée", authorization_expired: "autorisation déclarée expirée",
      authorization_out_of_scope: "autorisation déclarée hors périmètre", authorization_expiry_unknown: "expiration inconnue", authorization_reference_missing: "référence d’autorisation absente ou non retenue",
    }));
    items.push(`Passation ${id(h.id)} : ${label(h.futureSharing, { blocked_pending_qualification: "partage bloqué en attente de qualification", requires_trusted_authorization: "autorisation de confiance encore requise avant tout partage" })} ; motifs : ${reasons.length ? reasons.join(" ; ") : "aucun motif supplémentaire dans les affirmations fournies"}. Aucun rôle ne confère d’autorité ; aucune permission accordée, aucune transmission effectuée.`);
  }
  return { summary: `${entries.length} passation(s) fournie(s). Aucun destinataire ni pouvoir authentifié ; aucune transmission réalisée par cet outil.`, items };
}

/** Receives only the inert snapshot already inspected by the private-result boundary. */
export function projectResolutionResult(value: unknown): PrivateToolResultPayload {
  const raw = row(value, ["ok", "status", "qualificationOnly", "caseId", "snapshotRevision", "asOf", "provenance", "externalFactsVerified", "permissionsGranted", "externalActionsPerformed", "rejectedSourceIds", "suppliedReferences", "domains", "dependencies", "transitions", "effort", "corrections", "occurrence", "handoffs"]);
  fixed(raw.ok, true); fixed(raw.status, "preparation"); fixed(raw.qualificationOnly, true);
  fixed(raw.provenance, "caller_supplied_snapshot"); fixed(raw.externalFactsVerified, false); fixed(raw.permissionsGranted, false); fixed(raw.externalActionsPerformed, 0);
  const domainIds = new Set<string>();
  const domains = list(raw.domains, 14).map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const domainId = text((value as Row).id);
    if (!Object.hasOwn(RESOLUTION_DOMAINS, domainId) || domainIds.has(domainId)) return invalid();
    domainIds.add(domainId);
    const expected = RESOLUTION_DOMAINS[domainId as keyof typeof RESOLUTION_DOMAINS];
    const domain = row(value, ["id", "label", "routes", "serviceAvailability", ...(domainId === "N" ? ["ownership"] : [])]);
    fixed(domain.label, expected.label); fixed(domain.serviceAvailability, "not_qualified");
    if (domainId === "N") fixed(domain.ownership, "precise_business_owner_required");
    const routes = list(domain.routes, expected.routes.length);
    if (routes.length !== expected.routes.length || routes.some((route, index) => route !== expected.routes[index])) invalid();
    return `${domainId} — ${expected.label} : ${expected.routes.join(", ")}${domainId === "N" ? " ; responsable métier précis à identifier" : ""}.`;
  });
  const formatters = { dependencies, transitions, effort, corrections, occurrence, handoffs };
  const sections: ResolutionReportSection[] = RESOLUTION_REPORT_SECTIONS.map(section => raw[section.id] === null
    ? { ...section, availability: "not_provided", summary: "Aucune information fournie pour cette rubrique.", items: [] }
    : { ...section, availability: "provided", ...formatters[section.id](raw[section.id]) });
  const summary = "Qualification terminée de l’instantané fourni ; la résolution du dossier n’est pas attestée. Faits externes non vérifiés, permissions accordées : 0, actions externes réalisées : 0.\n"
    + (domains.length ? `Orientations vers les produits existants ; disponibilité des services non qualifiée :\n${domains.join("\n")}` : "Aucun domaine fourni ; disponibilité des services non qualifiée.");
  const payload: PrivateToolResultPayload = {
    schema_version: 1, tool_name: "qualify_resolution", status: "complete", summary, sources: [],
    details: { ...RESOLUTION_REPORT_PROVENANCE,
      snapshot: { caseId: text(raw.caseId), snapshotRevision: integer(raw.snapshotRevision), asOf: text(raw.asOf, 35) },
      sections, supplied_references: raw.suppliedReferences, rejected_source_ids: raw.rejectedSourceIds,
    },
  };
  if (!parseResolutionPrivatePayload(payload)) return invalid();
  return payload;
}
