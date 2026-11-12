import { createHash } from "node:crypto";
import { supabase } from "../db/supabase.js";
import { isGlobalKillSwitchActive } from "../engine/killswitch.js";
import { normalizeChefBrief, hashChefBrief, type ChefBrief } from "./brief.js";
import { parseWorkshopProjects, workshopProjectHash, WORKSHOP_ID, WORKSHOP_UUID, type WorkshopProject } from "./workshop-config.js";

export class WorkshopError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function invalid(): never { throw new WorkshopError(400, "WORKSHOP_INVALID", "Demande atelier invalide."); }
function dbCheck(error: { code?: string } | null): void {
  if (!error) return;
  const errors: Record<string, [number, string, string]> = {
    PW400: [400,"WORKSHOP_INVALID","Demande atelier invalide."],
    PW409: [409,"WORKSHOP_CONFLICT","Cette demande existe déjà avec un autre contenu."],
    PW423: [409,"WORKSHOP_BUSY","Une mission utilise déjà ce projet."],
    PW429: [429,"WORKSHOP_RATE_LIMIT","Limite de nouvelles missions atteinte. Réessaie plus tard."],
    PW503: [503,"WORKSHOP_UNAVAILABLE","Le service de création est temporairement indisponible."],
  };
  const entry = errors[error.code ?? ""];
  if (entry) throw new WorkshopError(...entry);
  throw new WorkshopError(503,"WORKSHOP_UNAVAILABLE","Le service de création est temporairement indisponible.");
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function buildWorkshopBrief(project: WorkshopProject, requestId: string, prompt: string): ChefBrief {
  const requirementKeys = ["PRODUCT", "QUALITY"];
  const context = "\nObjectif de l’utilisateur :\n" + prompt +
    "\nReste dans les fichiers autorisés. Aucun secret, paiement, publication ni modification d'infrastructure. " +
    "Signale tout prérequis externe manquant. Les vérifications doivent porter sur le résultat réel.";
  const common = {
    provider: "codex" as const, worktree: project.workdir,
    requirementKeys, maxAttempts: 3,
    estimatedTokens: project.estimatedTokensPerTask,
    ...(project.estimatedCostMicrosPerTask === undefined ? {} : { estimatedCostMicros: project.estimatedCostMicrosPerTask }),
  };
  return normalizeChefBrief({
    briefId: "workshop:" + project.id + ":" + requestId, version: 1, goal: prompt, repo: project.repo,
    requirements: [
      { key: "PRODUCT", description: "Livrer les parcours demandés avec des données et des actions réellement raccordées.", critical: true },
      { key: "QUALITY", description: "Vérifier compilation, comportement, erreurs, accessibilité et sécurité dans le périmètre du projet.", critical: true },
    ],
    tasks: [
      { ...common, key: "implementation", title: "Conception et réalisation", accessMode: "write",
        scopeKey: "workshop:" + project.id, allowedPaths: project.allowedPaths,
        verificationProfiles: project.implementationProfiles,
        instructions: "Examine l'existant, conçois et implémente l'objectif, vérifie et corrige les défauts reproductibles. " +
          "Le serveur enregistrera les changements autorisés dans Git. Ne lance aucune commande git add/commit et ne pousse ni ne déploie rien." + context },
      { ...common, key: "functional-review", title: "Contrôle fonctionnel indépendant", accessMode: "read",
        dependsOn: ["implementation"], verificationProfiles: project.reviewProfiles,
        instructions: "Contrôle indépendamment les parcours, les erreurs, l'ergonomie et l'accessibilité. Lecture seule. " +
          "Si une exigence ne fonctionne pas, renvoie failed et explique le défaut; ne déclare jamais completed par simple inspection superficielle." + context },
      { ...common, key: "security-review", title: "Contrôle sécurité et fiabilité", accessMode: "read",
        dependsOn: ["implementation"], verificationProfiles: project.reviewProfiles,
        instructions: "Vérifie indépendamment autorisations, séparation des données, validation d'entrées et reprise sur erreur. Lecture seule. " +
          "Retourne failed si un défaut empêche une livraison fiable; aucun déploiement." + context },
    ],
  });
}

export async function getWorkshopMission(userId: string, missionId: string) {
  const runResult = await supabase.from("chef_workshop_runs")
    .select("project_id,cancel_requested_at,finished_at").eq("user_id",userId).eq("mission_id",missionId).maybeSingle();
  dbCheck(runResult.error);
  if (!runResult.data) throw new WorkshopError(404,"WORKSHOP_NOT_FOUND","Mission introuvable.");
  const run = runResult.data;
  const [missionResult, tasksResult] = await Promise.all([
    supabase.from("chef_missions").select("id,goal,state,created_at,updated_at,finished_at,tokens_used,cost_used_micros")
      .eq("id",missionId).eq("user_id",userId).single(),
    supabase.from("chef_tasks").select("id,task_key,title,state,assigned_provider,provider,attempt,output_sha")
      .eq("mission_id",missionId).order("created_at").limit(256),
  ]);
  dbCheck(missionResult.error); dbCheck(tasksResult.error);
  const m = missionResult.data!;
  const tasks = tasksResult.data ?? [];
  const evidenceResult = tasks.length ? await supabase.from("chef_evidence").select("task_id")
    .in("task_id",tasks.map(t => t.id)).limit(2048) : { data: [], error: null };
  dbCheck(evidenceResult.error);
  const count = new Map<string,number>();
  for (const e of evidenceResult.data ?? []) count.set(e.task_id,(count.get(e.task_id) ?? 0)+1);
  return {
    id: m.id, projectId: run.project_id, title: String(m.goal).slice(0,160),
    state: run.cancel_requested_at && !run.finished_at ? "cancelling" : m.state,
    createdAt: m.created_at, updatedAt: m.updated_at,
    finishedAt: run.cancel_requested_at ? run.finished_at : m.finished_at,
    verifiedTasks: tasks.filter(t => t.state === "verified_done").length, totalTasks: tasks.length,
    usage: { tokens: Number(m.tokens_used), costMicros: Number(m.cost_used_micros) },
    tasks: tasks.map(t => ({
      id: t.id, key: t.task_key, title: t.title, state: t.state,
      provider: t.assigned_provider ?? (t.provider === "auto" ? null : t.provider),
      attempt: t.attempt, outputSha: t.state === "verified_done" ? t.output_sha ?? null : null, evidenceCount: count.get(t.id) ?? 0,
    })),
  };
}

export async function handleWorkshopRequest(userId: string, body: Record<string,unknown>) {
  if (!WORKSHOP_UUID.test(userId)) invalid();
  userId = userId.toLowerCase();
  const keys: Record<string,string[]> = {
    list: ["action"], status: ["action","missionId"], cancel: ["action","missionId"],
    start: ["action","projectId","requestId","prompt"],
  };
  if (typeof body.action !== "string" || !Object.hasOwn(keys,body.action) ||
      Object.keys(body).some(k => !keys[body.action as string].includes(k))) invalid();
  if (body.action === "status" || body.action === "cancel") {
    if (typeof body.missionId !== "string" || !WORKSHOP_UUID.test(body.missionId)) invalid();
    const id = body.missionId.toLowerCase();
    if (body.action === "cancel") {
      const result = await supabase.rpc("chef_workshop_cancel", {p_user_id:userId,p_mission_id:id});
      dbCheck(result.error);
      if (result.data !== true) throw new WorkshopError(404,"WORKSHOP_NOT_FOUND","Mission introuvable.");
      // Only succeeds if no active process claim and no quarantine remain.
      const finished = await supabase.rpc("chef_workshop_finish_cancel",{p_mission_id:id});
      dbCheck(finished.error);
    }
    return {ok:true,mission:await getWorkshopMission(userId,id)};
  }

  let projects: WorkshopProject[];
  try { projects = parseWorkshopProjects().filter(p => p.userIds.includes(userId)); }
  catch { throw new WorkshopError(503,"WORKSHOP_UNAVAILABLE","Configuration du service de création indisponible."); }
  if (body.action === "list") {
    const [runtimeResult, historyResult, stopped] = await Promise.all([
      supabase.from("chef_workshop_runtimes").select("project_id,config_hash,online,heartbeat_at")
        .in("project_id",projects.map(p => p.id)),
      supabase.from("chef_workshop_runs").select("mission_id,project_id,cancel_requested_at,finished_at").eq("user_id",userId)
        .order("created_at",{ascending:false}).limit(30),
      isGlobalKillSwitchActive(true),
    ]);
    dbCheck(runtimeResult.error); dbCheck(historyResult.error);
    const history = historyResult.data ?? [];
    const ids = history.map(r => r.mission_id);
    const [missionRows, taskRows] = ids.length ? await Promise.all([
      supabase.from("chef_missions").select("id,goal,state,created_at,updated_at,finished_at,tokens_used,cost_used_micros")
        .eq("user_id",userId).in("id",ids).limit(30),
      supabase.from("chef_tasks").select("mission_id,state").in("mission_id",ids).limit(256),
    ]) : [{data:[],error:null},{data:[],error:null}];
    dbCheck(missionRows.error); dbCheck(taskRows.error);
    const missions = history.flatMap(run => {
      const m = missionRows.data?.find(m => m.id === run.mission_id);
      if (!m) return [];
      const tasks = taskRows.data?.filter(t => t.mission_id === m.id) ?? [];
      return [{id:m.id,projectId:run.project_id,title:String(m.goal).slice(0,160),
        state:run.cancel_requested_at && !run.finished_at ? "cancelling" : m.state,
        createdAt:m.created_at,updatedAt:m.updated_at,
        finishedAt:run.cancel_requested_at ? run.finished_at : m.finished_at,
        verifiedTasks:tasks.filter(t => t.state === "verified_done").length,totalTasks:tasks.length,
        usage:{tokens:Number(m.tokens_used),costMicros:Number(m.cost_used_micros)}}];
    });
    return {ok:true, projects:projects.map(p => {
      const runtime = runtimeResult.data?.find(r => r.project_id === p.id);
      const ready = !stopped && runtime?.online === true && runtime.config_hash === workshopProjectHash(p) &&
        Date.parse(runtime.heartbeat_at) > Date.now()-20_000;
      return {id:p.id,name:p.name,maxParallel:p.maxParallel,ready,
        ...(!ready ? {unavailableReason:"Le service de création de ce projet n’est pas disponible."} : {})};
    }), missions};
  }
  if (typeof body.projectId !== "string" || !WORKSHOP_ID.test(body.projectId) ||
      typeof body.requestId !== "string" || !WORKSHOP_UUID.test(body.requestId) ||
      typeof body.prompt !== "string" || body.prompt.trim().length < 20 || body.prompt.trim().length > 6000 ||
      body.prompt.includes("\0")) invalid();
  const project = projects.find(p => p.id === body.projectId);
  if (!project) throw new WorkshopError(404,"WORKSHOP_NOT_FOUND","Projet introuvable.");
  if (await isGlobalKillSwitchActive(true)) throw new WorkshopError(503,"WORKSHOP_UNAVAILABLE","Création temporairement suspendue.");
  const requestId = body.requestId.toLowerCase();
  const prompt = body.prompt.trim();
  const brief = buildWorkshopBrief(project,requestId,prompt);
  const result = await supabase.rpc("chef_workshop_submit", {
    p_user_id:userId,p_project_id:project.id,p_request_id:requestId,
    p_request_hash:digest(JSON.stringify({projectId:project.id,prompt})),
    p_config_hash:workshopProjectHash(project),p_brief:brief,p_brief_hash:hashChefBrief(brief),
    p_max_parallel:project.maxParallel,p_token_budget:project.tokenBudget,
    p_cost_budget_micros:project.costBudgetMicros ?? null,
  });
  dbCheck(result.error);
  if (typeof result.data !== "string" || !WORKSHOP_UUID.test(result.data)) dbCheck({code:"invalid"});
  return {ok:true,mission:await getWorkshopMission(userId,String(result.data))};
}
