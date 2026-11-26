import { describe, expect, it } from "vitest";
import { qualifyResolution, type ResolutionInput } from "../src/lib/resolution-qualification.js";
import { projectPrivateToolResult } from "../src/engine/private-tool-results.js";
import { parsePrivateToolResult, parseResolutionPrivatePayload, RESOLUTION_REPORT_PROVENANCE, RESOLUTION_REPORT_SECTIONS, RESOLUTION_REPORT_MAX_BYTES } from "../src/knowledge/private-result-view.js";
const owner = "00000000-0000-4000-8000-000000000461", agent = "00000000-0000-4000-8000-000000000462";
const base = (): ResolutionInput => ({ caseId: "dossier-🌍", snapshotRevision: 3, asOf: "2026-11-26T12:00:00Z", domains: ["A", "N"], sources: [] });
function completeInput(): ResolutionInput {
  const input = base();
  input.sources = [
    { id: "provided", caseId: input.caseId, snapshotRevision: 3, subjectId: "a", kind: "requirement", reference: '<script>alert("source")</script> https://unverified.invalid/x', observedAt: "2026-11-25T12:00:00Z" },
    { id: "rejected-date", caseId: input.caseId, snapshotRevision: 3, subjectId: "a", kind: "satisfaction", reference: "Date impossible, conservée", observedAt: "2026-02-30T12:00:00Z" },
  ];
  input.dependencies = [
    { id: "a\nPASS", state: "unknown", basis: "hypothesis", requires: ["b", "missing"], sourceIds: [], satisfactionSourceIds: [], alternatives: [] },
    { id: "b", state: "unknown", basis: "interlocutor_request", requires: ["a\nPASS"], sourceIds: [], satisfactionSourceIds: [], alternatives: [] },
  ];
  input.transitions = [{ id: "transition", timeZone: "Europe/Paris", periods: [{ id: "period", stage: "desired", sourceIds: [] }] }];
  input.effort = { chosenMinutes: 2, paused: true, maxCalls: 0, steps: [{ id: "step", state: "pending" }] };
  input.corrections = [{ id: "correction", factId: "fact", fromVersion: 1, toVersion: 2, expectedVersion: 1, currentVersion: 2, assertion: "suspected", sourceIds: [],
    consequences: [{ id: "document", version: 1, dependsOn: ["fact", "unknown-fact"], stage: "transmitted" }, { id: "unlinked", version: 1, dependsOn: [], stage: "draft" }] }];
  const current = { episodeId: "episode", operationId: "op", payloadHash: "hash", beneficiaryId: "person", objectId: "object", periodId: "period", engagementId: "engagement", territory: "FR" };
  input.occurrence = { requested: "technical_retry", current, previous: { ...current, state: "open", effect: "uncertain", attempts: 1 }, attemptLimit: 3, revoked: false };
  input.handoffs = [{ id: "handoff", recipientId: "person", recipientState: "unknown", role: "aidant", channel: "declared", actionId: "share", dataIds: ["document"],
    requestedStage: "performed", conflicting: false, transmissionSourceIds: ["missing-ref"], acceptanceSourceIds: [], performanceSourceIds: [] }];
  return input;
}
const payload = (input = base()) => projectPrivateToolResult("qualify_resolution", qualifyResolution(input))!;
const stored = (data: unknown) => ({ id: "00000000-0000-4000-8000-000000000463", run_id: "00000000-0000-4000-8000-000000000464", user_id: owner, creator_agent_id: agent, tool_name: "qualify_resolution", payload: data, created_at: "2026-11-26T12:01:00Z" });
describe("resolution private projection and shared reader", () => {
  it("retains six unknown facets and supplied snapshot without manufacturing authority", () => {
    const data = payload();
    expect(data).toMatchObject({ status: "complete", sources: [], details: { ...RESOLUTION_REPORT_PROVENANCE, snapshot: { caseId: "dossier-🌍", snapshotRevision: 3, asOf: "2026-11-26T12:00:00Z" }, supplied_references: [], rejected_source_ids: [] } });
    const parsed = parsePrivateToolResult(stored(data), owner, agent)!;
    expect(parsed.payload.resolution?.sections).toEqual(RESOLUTION_REPORT_SECTIONS.map(section => ({ ...section, availability: "not_provided", summary: "Aucune information fournie pour cette rubrique.", items: [] })));
    expect(data.summary).toContain("responsable métier précis à identifier");
    expect(parsed.payload).not.toHaveProperty("details");
    expect(parsePrivateToolResult(stored(data), agent, owner)).toBeNull();
  });
  it("projects every facet with explicit unknowns, retained references and zero effects", () => {
    const input = completeInput(), before = structuredClone(input), data = payload(input);
    const result = parsePrivateToolResult(stored(data), owner, agent)!.payload.resolution!;
    expect(result.sections.map(section => section.id)).toEqual(RESOLUTION_REPORT_SECTIONS.map(section => section.id));
    expect(result.sections.every(section => section.availability === "provided")).toBe(true);
    expect(result.supplied_references).toEqual(input.sources); expect(result.rejected_source_ids).toEqual(["rejected-date"]); expect(data.sources).toEqual([]);
    const items = result.sections.flatMap(section => section.items).join("\n");
    expect(items).toContain('"a\\nPASS"'); expect(items).not.toContain("a\nPASS");
    expect(items).toContain("Groupe de prérequis interdépendants"); expect(items).toContain("Couverture réelle non vérifiée");
    expect(items).toContain("étude d’impact incomplète"); expect(items).toContain("rapprochement requis : oui"); expect(items).toContain("aucune transmission effectuée");
    expect(input).toEqual(before); input.sources[0].reference = "changed";
    expect(result.supplied_references[0].reference).toBe(before.sources[0].reference);
  });
  it.each([
    (r: Record<string, unknown>) => { r.permissionsGranted = true; },
    (r: Record<string, unknown>) => { r.externalFactsVerified = true; },
    (r: Record<string, unknown>) => { r.externalActionsPerformed = 1; },
    (r: Record<string, unknown>) => { r.provenance = "trusted_current_case"; },
    (r: Record<string, unknown>) => { delete r.transitions; },
    (r: Record<string, unknown>) => { r.asOf = "2026-02-30T12:00:00Z"; },
    (r: Record<string, unknown>) => { r.suppliedReferences = [{ ...completeInput().sources[0], externalVerified: true }]; },
    (r: Record<string, unknown>) => { r.rejectedSourceIds = []; },
    (r: Record<string, unknown>) => { (r.effort as Record<string, unknown>).healthInferencePerformed = true; },
    (r: Record<string, unknown>) => { (r.corrections as Record<string, unknown>[])[0].repaired = true; },
    (r: Record<string, unknown>) => { (r.occurrence as Record<string, unknown>).executionAuthorized = true; },
    (r: Record<string, unknown>) => { (r.handoffs as Record<string, unknown>[])[0].permissionGranted = true; },
  ])("refuses incompatible or authority-upgrading raw result (%#)", change => {
    const raw = qualifyResolution(completeInput()); change(raw); expect(() => projectPrivateToolResult("qualify_resolution", raw)).toThrow("Résultat privé indisponible");
  });
  it.each([
    (d: Record<string, unknown>) => { d.verification_status = "verified"; },
    (d: Record<string, unknown>) => { d.report_truncated = true; },
    (d: Record<string, unknown>) => { d.rejected_source_ids = ["provided"]; },
    (d: Record<string, unknown>) => { (d.sections as unknown[]).reverse(); },
    (d: Record<string, unknown>) => { (d.sections as unknown[]).pop(); },
    (d: Record<string, unknown>) => { (d.sections as Record<string, unknown>[])[0].unknown = "secret"; },
    (d: Record<string, unknown>) => { (d.snapshot as Record<string, unknown>).asOf = "2026-11-26T12:00:00+14:01"; },
    (d: Record<string, unknown>) => { (d.supplied_references as Record<string, unknown>[])[0].reference = "\ud800"; },
  ])("rejects tampered metadata instead of rendering partial report (%#)", change => {
    const data = payload(completeInput()); change(data.details); expect(parsePrivateToolResult(stored(data), owner, agent)).toBeNull();
  });
  it("enforces exact UTF-8 envelope boundary with spaces inside text", () => {
    const data = payload(), section = (data.details.sections as Record<string, unknown>[])[0];
    section.availability = "provided"; section.summary = "Texte fourni non vérifié";
    const items = Array.from({ length: 8 }, () => "x"); section.items = items;
    let remaining = RESOLUTION_REPORT_MAX_BYTES - Buffer.byteLength(JSON.stringify(data));
    for (let index = 0; index < items.length; index++) { const amount = Math.min(8_191, remaining); items[index] += " ".repeat(amount); remaining -= amount; }
    expect(remaining).toBe(0); expect(Buffer.byteLength(JSON.stringify(data))).toBe(RESOLUTION_REPORT_MAX_BYTES);
    expect(parseResolutionPrivatePayload(data)).not.toBeNull();
    items[0] = "é" + items[0].slice(1);
    expect(Buffer.byteLength(JSON.stringify(data))).toBe(RESOLUTION_REPORT_MAX_BYTES + 1); expect(parseResolutionPrivatePayload(data)).toBeNull();
  });
  it("rejects expanded full qualification instead of silently losing a facet", () => {
    const input = base();
    input.handoffs = Array.from({ length: 32 }, (_, index) => ({ id: `handoff-${index}-` + "x".repeat(140), recipientId: "person", recipientState: "unknown", role: "aidant", channel: "declared", actionId: "share", dataIds: [], requestedStage: "performed", conflicting: false, transmissionSourceIds: ["a".repeat(150), "a".repeat(149) + "2"], acceptanceSourceIds: ["b".repeat(150), "b".repeat(149) + "2"], performanceSourceIds: ["c".repeat(150), "c".repeat(149) + "2"] }));
    const qualified = qualifyResolution(input); expect(qualified.handoffs).toHaveLength(32);
    expect(() => projectPrivateToolResult("qualify_resolution", qualified)).toThrow("Résultat privé indisponible");
  });
});

describe("resolution Unicode input lengths through the private boundary", () => {
  it.each(["mixed", "astral"] as const)("delivers schema-bound identifiers and references exactly (%s)", style => {
    const bounded = (ascii: string, scalar: string, size: number) => style === "mixed" ? ascii.repeat(size - 1) + scalar : scalar.repeat(size);
    const input = base();
    input.caseId = bounded("c", "🌍", 160);
    const subjectId = bounded("p", "🏠", 160), validId = bounded("s", "🌿", 160), rejectedId = bounded("r", "🧭", 160);
    input.sources = [
      { id: validId, caseId: input.caseId, snapshotRevision: 3, subjectId, kind: "requirement", reference: bounded("d", "🌍", 500), observedAt: "2026-11-25T12:00:00Z" },
      { id: rejectedId, caseId: bounded("o", "🌊", 160), snapshotRevision: 3, subjectId, kind: "requirement", reference: "e\u0301 and é remain distinct supplied text", observedAt: bounded("x", "🌍", 35) },
    ];
    input.dependencies = [{ id: subjectId, state: "unknown", basis: "interlocutor_request", requires: [], sourceIds: [validId], satisfactionSourceIds: [], alternatives: [] }];
    const data = payload(input), result = parsePrivateToolResult(stored(data), owner, agent)!.payload.resolution!;
    expect(result.snapshot.caseId).toBe(input.caseId);
    expect(result.supplied_references).toEqual(input.sources);
    expect(result.rejected_source_ids).toEqual([rejectedId]);
    expect(result.sections[0].items.join("\n")).toContain(JSON.stringify(subjectId));
    expect(result.supplied_references[1].reference).not.toBe(input.sources[1].reference.normalize("NFC"));
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThan(RESOLUTION_REPORT_MAX_BYTES);
  });

  it.each(["caseId", "id", "sourceCaseId", "subjectId", "reference", "observedAt"])(
    "refuses a supplied %s above its code-point bound in both input and stored payload", field => {
      const input = completeInput();
      const maximum = field === "reference" ? 500 : field === "observedAt" ? 35 : 160;
      const tooLong = "🌍".repeat(maximum + 1);
      if (field === "caseId") input.caseId = tooLong;
      else input.sources[0][field === "sourceCaseId" ? "caseId" : field as "id" | "subjectId" | "reference" | "observedAt"] = tooLong;
      expect(() => qualifyResolution(input)).toThrow("Paramètres programmatiques non conformes");

      const data = payload(completeInput());
      const snapshot = data.details.snapshot as Record<string, unknown>;
      const refs = data.details.supplied_references as Record<string, unknown>[];
      if (field === "caseId") {
        snapshot.caseId = tooLong;
        for (const ref of refs) ref.caseId = tooLong;
      } else {
        refs[0][field === "sourceCaseId" ? "caseId" : field] = tooLong;
        if (field === "sourceCaseId" || field === "observedAt") data.details.rejected_source_ids = [refs[0].id, refs[1].id];
      }
      expect(parseResolutionPrivatePayload(data)).toBeNull();
    },
  );

  it("uses the input date minimum in code points while retaining malformed dates as rejected data", () => {
    const input = completeInput(); input.sources[0].observedAt = "🌍".repeat(20);
    expect(parseResolutionPrivatePayload(payload(input))?.rejected_source_ids).toEqual(["provided", "rejected-date"]);
    input.sources[0].observedAt = "🌍".repeat(19);
    expect(() => qualifyResolution(input)).toThrow("Paramètres programmatiques non conformes");
    const data = payload(completeInput());
    (data.details.supplied_references as Record<string, unknown>[])[0].observedAt = input.sources[0].observedAt;
    data.details.rejected_source_ids = ["provided", "rejected-date"];
    expect(parseResolutionPrivatePayload(data)).toBeNull();
  });

  it.each(["\u0000", "\ud800", "\udc00", "\ud800A"])("refuses malformed scalar text before qualification and when reading a tampered row (%#)", malformed => {
    for (const target of ["caseId", "reference"] as const) {
      const input = completeInput();
      if (target === "caseId") input.caseId = malformed; else input.sources[0].reference = malformed;
      expect(() => qualifyResolution(input)).toThrow("Texte de qualification invalide");
      const data = payload(completeInput());
      if (target === "caseId") (data.details.snapshot as Record<string, unknown>).caseId = malformed;
      else (data.details.supplied_references as Record<string, unknown>[])[0].reference = malformed;
      expect(parseResolutionPrivatePayload(data)).toBeNull();
    }
  });

  it("keeps dense Unicode identity lists complete or refuses the generated-item bound without clipping", () => {
    const input = base();
    const ids = Array.from({ length: 32 }, (_, index) => String(index).padStart(2, "0") + "🌍".repeat(158));
    input.dependencies = [{ id: "root", state: "unknown", basis: "hypothesis", requires: ids.slice(0, 24), sourceIds: [], satisfactionSourceIds: [], alternatives: [] }];
    let raw = qualifyResolution(input);
    expect(raw.dependencies?.requirements[0].unknownPrerequisites).toEqual(ids.slice(0, 24));
    const items = parseResolutionPrivatePayload(projectPrivateToolResult("qualify_resolution", raw)!)!.sections[0].items;
    for (const id of ids.slice(0, 24)) expect(items.join("\n")).toContain(JSON.stringify(id));
    expect(items.every(item => item.length <= 8_192)).toBe(true);

    input.dependencies[0].requires = ids; raw = qualifyResolution(input);
    expect(raw.dependencies?.requirements[0].unknownPrerequisites).toEqual(ids);
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(65_536);
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThan(RESOLUTION_REPORT_MAX_BYTES);
    expect(ids.map(id => JSON.stringify(id)).join(", ").length).toBeGreaterThan(8_192);
    expect(() => projectPrivateToolResult("qualify_resolution", raw)).toThrow("Résultat privé indisponible");
  });
});
