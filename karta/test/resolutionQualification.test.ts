import { describe, expect, it, vi } from "vitest";
import { qualifyResolution, RESOLUTION_DOMAINS, type ResolutionInput } from "../src/lib/resolution-qualification.js";

const base = (): ResolutionInput => ({ caseId: "case-a", snapshotRevision: 3, asOf: "2026-11-25T12:00:00Z", domains: ["A"], sources: [] });
function source(input: ResolutionInput, subjectId: string, kind: ResolutionInput["sources"][number]["kind"], observedAt = "2026-11-20T10:00:00Z") {
  const id = `ref-${input.sources.length}`;
  input.sources.push({ id, caseId: input.caseId, snapshotRevision: input.snapshotRevision, subjectId, kind, reference: "supplied document section 1", observedAt });
  return [id];
}
function requirement(input: ResolutionInput, id: string, requires: string[] = []): NonNullable<ResolutionInput["dependencies"]>[number] {
  return { id, requires, state: "unknown", basis: "interlocutor_request", sourceIds: source(input, id, "requirement"), satisfactionSourceIds: [], alternatives: [] };
}
function handoff(id = "handoff-a"): NonNullable<ResolutionInput["handoffs"]>[number] {
  return { id, recipientId: "person-a", recipientState: "reported_resolved", role: "parent", channel: "existing-qualified-channel",
    actionId: "receive-document", dataIds: ["document-a"], requestedStage: "prepared", conflicting: false,
    transmissionSourceIds: [], acceptanceSourceIds: [], performanceSourceIds: [] };
}
function occurrence(): NonNullable<ResolutionInput["occurrence"]> {
  const current = { episodeId: "episode-a", beneficiaryId: "beneficiary-a", objectId: "object-a", periodId: "period-a", engagementId: "contract-a", territory: "FR", operationId: "operation-a", payloadHash: "payload-a" };
  return { requested: "technical_retry", current, previous: { ...current, state: "open", effect: "none", attempts: 1 }, attemptLimit: 3, changeReason: "transport restored", revoked: false };
}

describe("resolution qualification boundary", () => {
  it("keeps all six missing facets unknown and maps fourteen existing routes without service claims", () => {
    const input = base(); input.domains = Object.keys(RESOLUTION_DOMAINS) as ResolutionInput["domains"];
    const before = structuredClone(input);
    const result = qualifyResolution(input);
    expect(result).toMatchObject({ qualificationOnly: true, externalFactsVerified: false, externalActionsPerformed: 0, permissionsGranted: false,
      dependencies: null, transitions: null, effort: null, corrections: null, occurrence: null, handoffs: null });
    expect(result.domains).toHaveLength(14);
    expect(result.domains.every(domain => domain.serviceAvailability === "not_qualified")).toBe(true);
    expect(result.domains.find(domain => domain.id === "N")).toHaveProperty("ownership", "precise_business_owner_required");
    expect(input).toEqual(before);
  });

  it.each(["2026-02-30T12:00:00Z", "2026-11-25T12:00:00", "2026-11-25T12:00:00+15:00"])("rejects invalid analysis time %s", asOf => {
    expect(() => qualifyResolution({ ...base(), asOf })).toThrow();
  });

  it("rejects injected trusted flags, ambiguous identities, proxies and accessors without evaluating them", () => {
    expect(() => qualifyResolution({ ...base(), externallyVerified: true })).toThrow();
    const input = base(); source(input, "x", "activation"); input.sources.push({ ...input.sources[0] });
    expect(() => qualifyResolution(input)).toThrow(/ambigus/);
    const getter = vi.fn(() => "case-secret");
    const accessor = { ...base() }; Object.defineProperty(accessor, "caseId", { enumerable: true, get: getter });
    expect(() => qualifyResolution(accessor)).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(() => qualifyResolution(new Proxy(base(), {}))).toThrow();
  });

  it("rejects oversized nested input before graph traversal", () => {
    const input = base(); input.dependencies = Array.from({ length: 33 }, (_, i) => requirement(input, `r-${i}`));
    expect(() => qualifyResolution(input)).toThrow();
  });

  it.each(["\u0000", "\ud800", "\udc00", "\ud800A"])("rejects malformed text inside optional nested input before returning a qualification (%#)", malformed => {
    const input = base(); input.handoffs = [handoff()]; input.handoffs[0].role = malformed;
    expect(() => qualifyResolution(input)).toThrow("Texte de qualification invalide");
    input.handoffs[0].role = "🌍 aidant";
    expect(qualifyResolution(input).handoffs).toHaveLength(1);
  });
});

describe("business dependencies and alternatives", () => {
  it("rejects reused alternative identities across requirements before a source can qualify two different alternatives", () => {
    const input = base(); const a = requirement(input, "a", ["b"]), b = requirement(input, "b", ["a"]);
    const sourceIds = source(input, "shared-alternative", "alternative"), acceptanceSourceIds = source(input, "shared-alternative", "acceptance");
    a.alternatives = [{ id: "shared-alternative", prerequisiteId: "b", state: "reported_accepted", sourceIds, acceptanceSourceIds }];
    b.alternatives = [{ id: "shared-alternative", prerequisiteId: "a", state: "reported_accepted", sourceIds, acceptanceSourceIds }];
    input.dependencies = [a, b]; expect(() => qualifyResolution(input)).toThrow(/ambigus/);
  });

  it("breaks a circular prerequisite only under supplied source and recipient-acceptance references", () => {
    const input = base();
    const a = requirement(input, "a", ["b"]), b = requirement(input, "b", ["a"]), independent = requirement(input, "independent");
    a.alternatives = [{ id: "alternate", prerequisiteId: "b", state: "reported_accepted", sourceIds: source(input, "alternate", "alternative"), acceptanceSourceIds: [] }];
    input.dependencies = [a, b, independent];
    let result = qualifyResolution(input).dependencies!;
    expect(result.originalCycles).toEqual([["a", "b"]]); expect(result.remainingCycles).toEqual([["a", "b"]]);
    expect(result.nextCandidateIds).toEqual(["independent"]);
    expect(result.alternatives[0].assessment).toBe("pending_acceptance");
    a.alternatives[0].acceptanceSourceIds = source(input, "alternate", "acceptance");
    result = qualifyResolution(input).dependencies!;
    expect(result.remainingCycles).toEqual([]); expect(result.nextCandidateIds).toEqual(["a", "independent"]);
    expect(result.nextCandidateIds).not.toContain("b"); expect(result.executionPlanCreated).toBe(false);
    a.state = "reported_satisfied"; a.satisfactionSourceIds = source(input, "a", "satisfaction");
    expect(qualifyResolution(input).dependencies!.nextCandidateIds).toEqual(["b", "independent"]);
  });

  it("keeps refused alternatives, contradictory requirements and unknown prerequisites bounded to affected branches", () => {
    const input = base(); const a = requirement(input, "a", ["missing"]), b = requirement(input, "b", ["b"]), c = requirement(input, "independent");
    a.state = "conflicting"; b.alternatives = [{ id: "alt", prerequisiteId: "b", state: "reported_refused", sourceIds: [], acceptanceSourceIds: [] }];
    input.dependencies = [a, b, c]; const result = qualifyResolution(input).dependencies!;
    expect(result.nextCandidateIds).toEqual(["independent"]);
    expect(result.remainingCycles).toEqual([["b"]]);
    expect(result.requirements[0].unknownPrerequisites).toEqual(["missing"]);
    expect(result.alternatives[0].assessment).toBe("reported_refused");
  });

  it.each(["case", "version", "future", "subject", "kind"] as const)("does not promote mismatched %s evidence", mismatch => {
    const input = base(); const a = requirement(input, "a"); input.dependencies = [a]; const ref = input.sources[0];
    if (mismatch === "case") ref.caseId = "other-case";
    if (mismatch === "version") ref.snapshotRevision = 2;
    if (mismatch === "future") ref.observedAt = "2026-11-26T00:00:00Z";
    if (mismatch === "subject") ref.subjectId = "other-person";
    if (mismatch === "kind") ref.kind = "authorization";
    expect(qualifyResolution(input).dependencies!.nextCandidateIds).toEqual([]);
  });
});

describe("coverage transitions", () => {
  it("rejects a period identity reused for two different transition functions", () => {
    const input = base(); const sourceIds = source(input, "shared-period", "activation");
    input.transitions = ["care", "housing"].map(id => ({ id, timeZone: "UTC", windowStart: "2026-11-20T00:00:00Z", windowEnd: "2026-11-21T00:00:00Z",
      periods: [{ id: "shared-period", start: "2026-11-20T00:00:00Z", end: "2026-11-21T00:00:00Z", stage: "reported_active", sourceIds }] }));
    expect(() => qualifyResolution(input)).toThrow(/ambigus/);
  });

  it("calculates gaps and overlaps only from referenced active claims, never desired or cancelled periods", () => {
    const input = base(); input.transitions = [{ id: "care", timeZone: "Europe/Paris", windowStart: "2026-11-21T00:00:00+01:00", windowEnd: "2026-11-25T00:00:00+01:00", periods: [
      { id: "old", start: "2026-11-21T00:00:00+01:00", end: "2026-11-23T00:00:00+01:00", stage: "reported_active", sourceIds: source(input, "old", "activation") },
      { id: "next", start: "2026-11-22T00:00:00+01:00", end: "2026-11-24T00:00:00+01:00", stage: "reported_active", sourceIds: source(input, "next", "activation") },
      { id: "wished", start: "2026-11-24T00:00:00+01:00", end: "2026-11-25T00:00:00+01:00", stage: "agreed", sourceIds: source(input, "wished", "activation") },
    ] }];
    const result = qualifyResolution(input).transitions![0];
    expect(result.gaps).toEqual([{ start: "2026-11-23T23:00:00.000Z", end: "2026-11-24T23:00:00.000Z" }]);
    expect(result.overlaps).toEqual([{ start: "2026-11-21T23:00:00.000Z", end: "2026-11-22T23:00:00.000Z" }]);
    expect(result.actualCoverageVerified).toBe(false); expect(result.previousServiceClosureAuthorized).toBe(false);
    input.transitions[0].periods[1].stage = "cancelled";
    expect(qualifyResolution(input).transitions![0].gaps).toEqual([{ start: "2026-11-22T23:00:00.000Z", end: "2026-11-24T23:00:00.000Z" }]);
  });

  it("retains an unknown horizon or period, rejects false active claims, and handles explicit daylight-saving offsets", () => {
    const input = base(); input.transitions = [{ id: "move", timeZone: "Europe/Paris", periods: [
      { id: "unknown", stage: "reported_active", sourceIds: source(input, "unknown", "activation") },
    ] }];
    let result = qualifyResolution(input).transitions![0];
    expect(result.gaps).toBeNull(); expect(result.unknownPeriodIds).toEqual(["unknown"]);
    input.transitions[0].windowStart = "2026-10-25T01:30:00+02:00";
    input.transitions[0].windowEnd = "2026-10-25T03:30:00+01:00";
    result = qualifyResolution(input).transitions![0];
    expect(result.gaps).toEqual([{ start: "2026-10-24T23:30:00.000Z", end: "2026-10-25T02:30:00.000Z" }]);
    input.transitions[0].periods = [{ id: "false-active", start: input.transitions[0].windowStart, end: input.transitions[0].windowEnd, stage: "reported_active", sourceIds: [] }];
    expect(qualifyResolution(input).transitions![0].excludedPeriodIds).toEqual(["false-active"]);
  });
});

describe("human effort and correction impacts", () => {
  it("exposes missing intermediates and does not assert unaffected consequences from an incomplete graph", () => {
    const input = base(); input.corrections = [{ id: "fix", factId: "date", fromVersion: 1, toVersion: 2, expectedVersion: 1, currentVersion: 1,
      assertion: "reported_established", sourceIds: source(input, "fix", "correction"), consequences: [
        { id: "sent", version: 1, stage: "transmitted", dependsOn: ["missing-draft"] },
        { id: "effect", version: 1, stage: "performed", dependsOn: ["sent"] },
      ] }];
    const result = qualifyResolution(input).corrections![0];
    expect(result).not.toHaveProperty("unaffectedIds");
    expect(result).toMatchObject({ impactAssessmentComplete: false, unresolvedDependencies: [{ id: "sent", missingIds: ["missing-draft"] }], impactUnknownIds: ["sent", "effect"] });
  });

  it("uses the existing 2/10/25-minute choice, excludes completed work and preserves pause without permissions", () => {
    const input = base(); input.effort = { chosenMinutes: 2, maxCalls: 0, maxTrips: 0, paused: false, steps: [
      { id: "done", state: "completed", estimatedMinutes: 1, calls: 0, trips: 0 },
      { id: "long", state: "pending", estimatedMinutes: 10, calls: 0, trips: 0 },
      { id: "unknown", state: "pending" },
      { id: "short", state: "pending", estimatedMinutes: 2, calls: 0, trips: 0 },
    ] };
    let result = qualifyResolution(input).effort!;
    expect(result.nextStepId).toBe("short"); expect(result.completedStepIds).toEqual(["done"]);
    expect(result.authorizationChanged).toBe(false); expect(result.healthInferencePerformed).toBe(false);
    expect(result.assessments.find(step => step.id === "unknown")?.reasons).toContain("duration_unknown");
    input.effort.paused = true; result = qualifyResolution(input).effort!;
    expect(result.nextStepId).toBeNull(); expect(result.remindersCreated).toBe(false);
    delete input.effort.chosenMinutes; input.effort.paused = false;
    expect(qualifyResolution(input).effort!.chosenMinutes).toBeNull();
  });

  it("traces transitive consequences, separates drafts/transmissions/effects and never overwrites concurrent versions", () => {
    const input = base(); input.corrections = [{ id: "fix", factId: "date", fromVersion: 1, toVersion: 2, expectedVersion: 1, currentVersion: 1,
      assertion: "reported_established", sourceIds: source(input, "fix", "correction"), consequences: [
        { id: "draft", version: 2, stage: "draft", dependsOn: ["date"] },
        { id: "sent", version: 3, stage: "transmitted", dependsOn: ["draft"] },
        { id: "done", version: 4, stage: "performed", dependsOn: ["sent"] },
        { id: "unrelated", version: 1, stage: "draft", dependsOn: [] },
      ] }];
    let result = qualifyResolution(input).corrections![0];
    expect(result.consequences.map(item => item.next)).toEqual(["prepare_local_revision", "prepare_external_rectification", "reconcile_existing_effect"]);
    expect(result.notLinkedBySuppliedGraphIds).toEqual(["unrelated"]); expect(result.repaired).toBe(false); expect(result.modificationsPerformed).toBe(0);
    input.corrections[0].currentVersion = 3; result = qualifyResolution(input).corrections![0];
    expect(result.assessment).toBe("version_conflict"); expect(result.consequences.every(item => item.next === "reconcile_versions")).toBe(true);
    input.corrections[0].currentVersion = 1; input.corrections[0].assertion = "suspected";
    expect(qualifyResolution(input).corrections![0].assessment).toBe("correction_unestablished");
  });
});

describe("episodes, reopening and technical retry", () => {
  it.each(["uncertain", "executed"] as const)("does not hide a prior %s effect by changing the episode label", effect => {
    const input = base(); input.occurrence = occurrence(); input.occurrence.previous!.effect = effect;
    input.occurrence.requested = "new_episode"; input.occurrence.current.episodeId = "renamed-episode";
    expect(qualifyResolution(input).occurrence!.assessment).toBe(effect === "uncertain" ? "reconcile_unknown_effect" : "already_performed_no_replay");
  });

  it("retains uncertain effects when reopening a closed episode", () => {
    const input = base(); input.occurrence = occurrence(); input.occurrence.previous!.effect = "uncertain";
    input.occurrence.previous!.state = "closed"; input.occurrence.requested = "reopen";
    expect(qualifyResolution(input).occurrence!.assessment).toBe("reconcile_unknown_effect");
  });

  it("qualifies an exact justified retry without creating a retry or scheduler", () => {
    const input = base(); input.occurrence = occurrence();
    expect(qualifyResolution(input).occurrence).toMatchObject({ assessment: "technical_replay_candidate", executionAuthorized: false, attemptsCreated: 0, scheduleCreated: false });
  });

  it.each([
    ["unknown effect", (o: NonNullable<ResolutionInput["occurrence"]>) => { o.previous!.effect = "uncertain"; }, "reconcile_unknown_effect"],
    ["completed effect", (o: NonNullable<ResolutionInput["occurrence"]>) => { o.previous!.effect = "executed"; }, "already_performed_no_replay"],
    ["changed payload", (o: NonNullable<ResolutionInput["occurrence"]>) => { o.current.payloadHash = "changed"; }, "operation_identity_conflict"],
    ["new territory", (o: NonNullable<ResolutionInput["occurrence"]>) => { o.current.territory = "BE"; }, "different_context_do_not_merge"],
    ["new episode", (o: NonNullable<ResolutionInput["occurrence"]>) => { o.current.episodeId = "episode-b"; }, "different_episode_do_not_replay"],
    ["attempt cap", (o: NonNullable<ResolutionInput["occurrence"]>) => { o.previous!.attempts = 3; }, "attempt_limit_reached"],
    ["refusal", (o: NonNullable<ResolutionInput["occurrence"]>) => { o.previous!.state = "refused"; }, "refusal_requires_changed_business_request"],
    ["revocation", (o: NonNullable<ResolutionInput["occurrence"]>) => { o.revoked = true; }, "revoked_no_retry"],
    ["no justification", (o: NonNullable<ResolutionInput["occurrence"]>) => { delete o.changeReason; }, "retry_not_justified"],
  ] as const)("preserves the %s boundary", (_name, edit, expected) => {
    const input = base(); input.occurrence = occurrence(); edit(input.occurrence);
    expect(qualifyResolution(input).occurrence!.assessment).toBe(expected);
  });

  it("keeps an explicit reopening separate from a new episode and an exact replay", () => {
    const input = base(); input.occurrence = occurrence(); input.occurrence.requested = "reopen"; input.occurrence.previous!.state = "closed";
    expect(qualifyResolution(input).occurrence!.assessment).toBe("reopening_candidate");
    input.occurrence.requested = "new_episode";
    expect(qualifyResolution(input).occurrence!.assessment).toBe("possible_duplicate_episode");
    input.occurrence.current.episodeId = "new-episode";
    input.occurrence.current.operationId = "new-operation";
    expect(qualifyResolution(input).occurrence!.assessment).toBe("new_episode_candidate");
  });
});

describe("handoff facts and authorization boundary", () => {
  it("retains four distinct stages, refuses an unsupported performed claim and never turns references into independent verification", () => {
    const input = base(); const h = handoff(); h.requestedStage = "performed"; input.handoffs = [h];
    expect(qualifyResolution(input).handoffs![0].referencedStage).toBe("prepared");
    h.transmissionSourceIds = source(input, h.id, "transmission", "2026-11-20T10:00:00Z");
    expect(qualifyResolution(input).handoffs![0].referencedStage).toBe("transmitted");
    h.acceptanceSourceIds = source(input, h.id, "responsibility", "2026-11-21T10:00:00Z");
    expect(qualifyResolution(input).handoffs![0].referencedStage).toBe("accepted");
    h.performanceSourceIds = source(input, h.id, "performance", "2026-11-22T10:00:00Z");
    expect(qualifyResolution(input).handoffs![0]).toMatchObject({ referencedStage: "performed", externalStageVerified: false, transmittedByThisTool: false, permissionGranted: false });
    h.conflicting = true;
    expect(qualifyResolution(input).handoffs![0].referencedStage).toBe("prepared");
  });

  it("keeps event order unknown when an acceptance is consulted after the performance document", () => {
    const input = base(); const h = handoff(); h.requestedStage = "performed"; input.handoffs = [h];
    h.transmissionSourceIds = source(input, h.id, "transmission", "2026-11-20T10:00:00Z");
    h.acceptanceSourceIds = source(input, h.id, "responsibility", "2026-11-22T10:00:00Z");
    h.performanceSourceIds = source(input, h.id, "performance", "2026-11-21T10:00:00Z");
    const result = qualifyResolution(input).handoffs![0];
    expect(result).toMatchObject({ referencedStage: "performed", stageOrderVerified: false, externalStageVerified: false,
      stageReferenceIds: { transmitted: h.transmissionSourceIds, accepted: h.acceptanceSourceIds, performed: h.performanceSourceIds } });
    expect(result.reasons).not.toContain("contradictory_stage_order");
  });

  it("does not derive rights from parent/professional role, high autonomy, or another dossier's authorization", () => {
    const input = base(); const h = handoff(); input.handoffs = [h];
    expect(qualifyResolution(input).handoffs![0].reasons).toContain("authorization_missing");
    h.authorization = { status: "reported_valid", caseId: "other-case", actorId: "person-a", actionIds: ["receive-document"], dataIds: ["document-a"],
      expiresAt: "2026-12-01T00:00:00Z", sourceIds: source(input, h.id, "authorization") };
    expect(qualifyResolution(input).handoffs![0].reasons).toContain("authorization_out_of_scope");
    h.authorization.caseId = input.caseId;
    expect(qualifyResolution(input).handoffs![0]).toMatchObject({ futureSharing: "requires_trusted_authorization", roleGrantsAuthority: false, permissionGranted: false });
    h.authorization.dataIds = [];
    expect(qualifyResolution(input).handoffs![0].reasons).toContain("authorization_out_of_scope");
    expect(() => qualifyResolution({ ...input, autonomyLevel: 3 })).toThrow();
  });

  it.each(["revoked", "expired"] as const)("keeps %s authorization local to the concerned handoff", status => {
    const input = base(); const blocked = handoff("blocked"), independent = handoff("independent"); input.handoffs = [blocked, independent];
    for (const h of input.handoffs) h.authorization = { status: "reported_valid", caseId: input.caseId, actorId: h.recipientId, actionIds: [h.actionId], dataIds: [...h.dataIds],
      expiresAt: "2026-12-01T00:00:00Z", sourceIds: source(input, h.id, "authorization") };
    blocked.authorization!.status = status;
    const result = qualifyResolution(input).handoffs!;
    expect(result[0].futureSharing).toBe("blocked_pending_qualification");
    expect(result[1].futureSharing).toBe("requires_trusted_authorization");
    expect(result.every(h => h.permissionGranted === false)).toBe(true);
  });
});

describe("bounded supplied-reference retention", () => {
  it("preserves seven unauthenticated fields and rejected identities without aliasing the caller", () => {
    const input = base(); source(input, "subject", "requirement"); source(input, "subject", "satisfaction", "2026-02-30T12:00:00Z");
    const expected = structuredClone(input.sources), result = qualifyResolution(input);
    expect(result.suppliedReferences).toEqual(expected);
    expect(result.rejectedSourceIds).toEqual([expected[1].id]);
    expect(result.suppliedReferences[0]).not.toBe(input.sources[0]);
    input.sources[0].reference = "caller changed later";
    expect(result.suppliedReferences).toEqual(expected);
    expect(result.externalFactsVerified).toBe(false);
  });
});
