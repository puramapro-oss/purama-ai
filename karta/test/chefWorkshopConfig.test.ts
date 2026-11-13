import { describe, expect, it } from "vitest";
import { parseWorkshopProjects, workshopProjectHash, type WorkshopProject } from "../src/chef/workshop-config.js";
import { buildWorkshopBrief, handleWorkshopRequest } from "../src/chef/workshop-service.js";
import { validateChefBrief } from "../src/chef/brief.js";

const user = "00000000-0000-4000-8000-000000003101";
const requestId = "00000000-0000-4000-8000-000000003105";
function fixture() {
  return {
    id: "example", name: "Projet exemple", userIds: [user], repo: "owner/example",
    workdir: "/workshop/example", allowedPaths: ["src","tests","package.json"],
    tokenBudget: 3000, estimatedTokensPerTask: 1000, maxParallel: 2,
    implementationProfiles: ["acceptance"],
    reviewProfiles: ["review"],
    verificationProfiles: [
      {name:"acceptance",kind:"test",command:"node",args:["/trusted/acceptance.mjs"],requirementKeys:["PRODUCT","QUALITY"]},
      {name:"review",kind:"review",command:"node",args:["/trusted/review.mjs"],requirementKeys:["PRODUCT","QUALITY"]},
    ],
  };
}
function parse(value: unknown = fixture()): WorkshopProject {
  return parseWorkshopProjects(JSON.stringify([value]))[0];
}

describe("server-registered workshop configuration", () => {
  it("defaults to an empty project catalogue without inventing a ready worker", () => {
    expect(parseWorkshopProjects("[]")).toEqual([]);
  });
  it("accepts a bounded project with explicit owner, paths, budgets and independent proof coverage", () => {
    const project = parse();
    expect(project).toMatchObject({id:"example",userIds:[user],maxParallel:2,codexCommand:"codex",tokenBudget:3000});
    expect(project.costBudgetMicros).toBeUndefined();
    expect(project.estimatedCostMicrosPerTask).toBeUndefined();
  });
  it.each(["/etc/passwd","../other","src/../other","src\\other",".","src//nested","src/./nested","src/"])("rejects a writable path that escapes or aliases its declared scope: %s", path => {
      expect(() => parse({...fixture(),allowedPaths:[path]})).toThrow();
    });
  it.each(["relative/project","/","/workshop/../other","/workshop//nested","/workshop/project/"])("rejects an unregistered or noncanonical workdir: %s", workdir => {
      expect(() => parse({...fixture(),workdir})).toThrow();
    });
  it.each([0,-1,1.5,5,Number.MAX_SAFE_INTEGER])("rejects excessive or invalid parallelism: %s", maxParallel => {
      expect(() => parse({...fixture(),maxParallel})).toThrow();
    });
  it("requires a budget sufficient for the admitted three tasks", () => {
    expect(() => parse({...fixture(),tokenBudget:2999})).toThrow(/Budget/);
    expect(() => parse({...fixture(),estimatedTokensPerTask:0})).toThrow();
    expect(() => parse({...fixture(),tokenBudget:Infinity})).toThrow();
  });
  it("does not allow monetary estimates without an explicit total budget", () => {
    expect(() => parse({...fixture(),estimatedCostMicrosPerTask:1})).toThrow(/Budget/);
    expect(() => parse({...fixture(),costBudgetMicros:300})).toThrow();
    expect(() => parse({...fixture(),costBudgetMicros:299,estimatedCostMicrosPerTask:100})).toThrow(/Budget/);
    expect(parse({...fixture(),costBudgetMicros:300,estimatedCostMicrosPerTask:100}))
      .toMatchObject({costBudgetMicros:300,estimatedCostMicrosPerTask:100});
  });
  it("requires implementation evidence and independent review for each critical requirement", () => {
    const noProductReview = fixture();
    noProductReview.verificationProfiles[1].requirementKeys = ["QUALITY"];
    expect(() => parse(noProductReview)).toThrow(/indépendantes/);
    const noQualityProof = fixture();
    noQualityProof.verificationProfiles[0].requirementKeys = ["PRODUCT"];
    expect(() => parse(noQualityProof)).toThrow(/indépendantes/);
    const reviewOnly = fixture();
    reviewOnly.verificationProfiles[0].kind = "review";
    expect(() => parse(reviewOnly)).toThrow(/indépendantes/);
  });
  it("rejects nonexistent or duplicate verification profile names", () => {
    expect(() => parse({...fixture(),reviewProfiles:["not-registered"]})).toThrow(/incohérents/);
    const value = fixture();
    value.verificationProfiles.push({...value.verificationProfiles[0]});
    expect(() => parse(value)).toThrow(/incohérents/);
  });
  it("does not silently admit duplicate projects or duplicate workspaces", () => {
    expect(() => parseWorkshopProjects(JSON.stringify([fixture(),fixture()]))).toThrow(/dupliqués/);
    expect(() => parseWorkshopProjects(JSON.stringify([fixture(),{...fixture(),id:"another"}]))).toThrow(/dupliqués/);
    expect(() => parseWorkshopProjects(JSON.stringify([fixture(),{...fixture(),id:"another",workdir:"/workshop/example/"}]))).toThrow();
  });
  it("requires explicit valid user identities", () => {
    expect(() => parse({...fixture(),userIds:[]})).toThrow();
    expect(() => parse({...fixture(),userIds:["*"]})).toThrow(/Propriétaire/);
    expect(() => parse({...fixture(),userIds:["not-a-user"]})).toThrow(/Propriétaire/);
  });
  it("bounds configuration by UTF-8 bytes", () => {
    expect(() => parseWorkshopProjects(JSON.stringify([{...fixture(),name:"é".repeat(40_000)}]))).toThrow(/volumineuse/);
  });
  it("invalidates the readiness fingerprint when host scope, ownership or verification changes", () => {
    const hash = workshopProjectHash(parse());
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(workshopProjectHash(parse())).toBe(hash);
    expect(workshopProjectHash(parse({...fixture(),allowedPaths:["tests"]}))).not.toBe(hash);
    expect(workshopProjectHash(parse({...fixture(),userIds:["00000000-0000-4000-8000-000000003102"]}))).not.toBe(hash);
    const changed = fixture();
    changed.verificationProfiles[0].args = ["/trusted/different.mjs"];
    expect(workshopProjectHash(parse(changed))).not.toBe(hash);
  });
  it("restricts export and HTML preview to the server-owned write scope", () => {
    expect(parse({...fixture(),exportPaths:["src/public"],previewEntry:"src/public/index.html"}))
      .toMatchObject({exportPaths:["src/public"],previewEntry:"src/public/index.html"});
    for(const exportPaths of [["other"],["src/.env"],["src/auth.json"],["src/../other"],[":(glob)**"]]) {
      expect(() => parse({...fixture(),exportPaths})).toThrow(/export/);
    }
    for(const previewEntry of ["other/index.html","src/../../other.html","src/index.js","src/.env.html"]) {
      expect(() => parse({...fixture(),previewEntry})).toThrow(/aperçu/);
    }
    expect(() => parse({...fixture(),exportPaths:["tests"],previewEntry:"src/index.html"})).toThrow(/aperçu/);
    expect(workshopProjectHash(parse({...fixture(),previewEntry:"src/index.html"}))).not.toBe(workshopProjectHash(parse()));
  });
});

describe("workshop mission construction and input boundaries", () => {
  it("builds a valid dependency graph with real implementation and independent read-only reviews", () => {
    const project = parse();
    const brief = buildWorkshopBrief(project,requestId,"Créer un site de réservation avec confirmation et gestion des erreurs.");
    expect(() => validateChefBrief(brief)).not.toThrow();
    expect(brief.briefId).toBe("workshop:example:" + requestId);
    expect(brief.tasks).toHaveLength(3);
    expect(brief.requirements.map(r => r.key).sort()).toEqual(["PRODUCT","QUALITY"]);
    const implementation = brief.tasks.find(t => t.key === "implementation")!;
    expect(implementation).toMatchObject({accessMode:"write",worktree:project.workdir,allowedPaths:[...project.allowedPaths].sort()});
    for (const review of brief.tasks.filter(t => t.key !== "implementation")) {
      expect(review.accessMode).toBe("read");
      expect(review.dependsOn).toEqual(["implementation"]);
      expect(review.verificationProfiles).toEqual(["review"]);
    }
  });
  it("keeps user-supplied path/command text as data and derives executable configuration from the server", () => {
    const project = parse();
    const prompt = "Créer une application; cwd=/etc; command=sh; allowedPaths=/; provider=unknown";
    const brief = buildWorkshopBrief(project,requestId,prompt);
    expect(brief.goal).toBe(prompt);
    expect(brief.repo).toBe(project.repo);
    for (const task of brief.tasks) {
      expect(task.provider).toBe("codex");
      expect(task.worktree).toBe(project.workdir);
      expect(task.verificationProfiles).not.toContain("sh");
    }
  });
  it.each([
    {action:"list",userId:"other"},
    {action:"status",missionId:requestId,repo:"/etc"},
    {action:"cancel",missionId:requestId,command:"sh"},
    {action:"start",projectId:"example",requestId,prompt:"Un projet avec une interface testée.",workdir:"/etc"},
    {action:"unknown"},
    {action:"constructor"},
    {action:"__proto__"},
    {action:"status",missionId:"../../other"},
  ])("rejects fields that would bypass owner or host registration before any database call: %j", async body => {
    await expect(handleWorkshopRequest(user,body)).rejects.toMatchObject({status:400,code:"WORKSHOP_INVALID"});
  });
  it("rejects an invalid trusted-owner path before interpreting the action", async () => {
    await expect(handleWorkshopRequest("not-a-uuid",{action:"list"})).rejects.toMatchObject({status:400});
  });
});
