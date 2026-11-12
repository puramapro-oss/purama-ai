import { supabase } from '@/integrations/supabase/client';

export const MISSION_STATES = ['planning', 'active', 'paused', 'human_required', 'external_required', 'verified_done', 'failed', 'cancelled', 'cancelling'] as const;
export const TASK_STATES = ['pending', 'ready', 'claimed', 'running', 'verifying', 'retryable', 'blocked_human', 'blocked_external', 'verified_done', 'failed', 'cancelled'] as const;
export type MissionState = typeof MISSION_STATES[number];
export type TaskState = typeof TASK_STATES[number];
export interface WorkshopProject { id: string; name: string; ready: boolean; unavailableReason?: string; maxParallel: number }
export interface WorkshopTask { id: string; key: string; title: string; state: TaskState; provider: string | null; attempt: number; outputSha: string | null; evidenceCount: number }
export interface WorkshopMission {
  id: string; projectId: string; title: string; state: MissionState; createdAt: string; updatedAt: string;
  finishedAt: string | null; verifiedTasks: number; totalTasks: number; usage: { tokens: number; costMicros: number };
}
export interface WorkshopDetail extends WorkshopMission { tasks: WorkshopTask[]; previewUrl?: string }
export interface WorkshopList { projects: WorkshopProject[]; missions: WorkshopMission[] }
type WorkshopRequest =
  | { action: 'list' }
  | { action: 'status' | 'cancel'; missionId: string }
  | { action: 'start'; projectId: string; prompt: string; requestId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => new Error('Réponse de l’atelier invalide. Actualisez avant de poursuivre.');
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
const text = (value: unknown, max = 6000): string => {
  if (typeof value !== 'string' || !value.length || value.length > max) throw invalid();
  return value;
};
const count = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid();
  return value as number;
};
const uuid = (value: unknown): string => {
  const result = text(value, 36);
  if (!UUID.test(result)) throw invalid();
  return result;
};
const date = (value: unknown): string => {
  const result = text(value, 64);
  if (!Number.isFinite(Date.parse(result))) throw invalid();
  return result;
};
const array = (value: unknown, max: number): unknown[] => {
  if (!Array.isArray(value) || value.length > max) throw invalid();
  return value;
};
function state<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw invalid();
  return value as T;
}
export function safePreviewUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 2048) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password) throw invalid();
  return url.href;
}
function parseMission(value: unknown): WorkshopMission {
  const item = object(value);
  const usage = object(item.usage);
  const result: WorkshopMission = {
    id: uuid(item.id), projectId: text(item.projectId, 128), title: text(item.title),
    state: state(item.state, MISSION_STATES),
    createdAt: date(item.createdAt), updatedAt: date(item.updatedAt),
    finishedAt: item.finishedAt == null ? null : date(item.finishedAt),
    verifiedTasks: count(item.verifiedTasks), totalTasks: count(item.totalTasks),
    usage: { tokens: count(usage.tokens), costMicros: count(usage.costMicros) },
  };
  if (result.verifiedTasks > result.totalTasks || result.totalTasks > 256
    || (result.state === 'verified_done' && (!result.totalTasks || result.verifiedTasks !== result.totalTasks))) throw invalid();
  return result;
}
function parseTask(value: unknown): WorkshopTask {
  const item = object(value);
  const outputSha = item.outputSha == null ? null : text(item.outputSha, 64);
  if (outputSha && !/^[0-9a-f]{40,64}$/i.test(outputSha)) throw invalid();
  return {
    id: uuid(item.id), key: text(item.key, 128), title: text(item.title),
    state: state(item.state, TASK_STATES), provider: item.provider == null ? null : text(item.provider, 128),
    attempt: count(item.attempt), outputSha, evidenceCount: count(item.evidenceCount),
  };
}
export function parseWorkshopDetail(value: unknown): WorkshopDetail {
  const item = object(value);
  const mission = parseMission(item);
  const tasks = array(item.tasks, 256).map(parseTask);
  if (tasks.length !== mission.totalTasks || new Set(tasks.map(task => task.id)).size !== tasks.length
    || tasks.filter(task => task.state === 'verified_done').length !== mission.verifiedTasks) throw invalid();
  return { ...mission, tasks, previewUrl: safePreviewUrl(item.previewUrl) };
}
export function parseWorkshopList(value: unknown): WorkshopList {
  const item = object(value);
  const projects = array(item.projects, 128).map(raw => {
    const project = object(raw);
    if (typeof project.ready !== 'boolean') throw invalid();
    const maxParallel = count(project.maxParallel);
    if (maxParallel < 1 || maxParallel > 64) throw invalid();
    return {
      id: text(project.id, 128), name: text(project.name, 256), ready: project.ready, maxParallel,
      ...(project.unavailableReason ? { unavailableReason: text(project.unavailableReason, 1000) } : {}),
    };
  });
  const missions = array(item.missions, 100).map(parseMission);
  if (new Set(projects.map(project => project.id)).size !== projects.length
    || new Set(missions.map(mission => mission.id)).size !== missions.length) throw invalid();
  return { projects, missions };
}
export function isMissionRunning(value: MissionState): boolean { return value === 'active' || value === 'planning' || value === 'cancelling'; }
export function isMissionTerminal(value: MissionState): boolean { return value === 'verified_done' || value === 'failed' || value === 'cancelled'; }

export async function requestWorkshop(input: { action: 'list' }, signal?: AbortSignal): Promise<WorkshopList>;
export async function requestWorkshop(input: Exclude<WorkshopRequest, { action: 'list' }>, signal?: AbortSignal): Promise<WorkshopDetail>;
export async function requestWorkshop(input: WorkshopRequest, signal?: AbortSignal): Promise<WorkshopList | WorkshopDetail> {
  const { data, error } = await supabase.functions.invoke('chef-workshop', { body: input, signal, timeout: 15_000 });
  if (signal?.aborted) throw new DOMException('Requête annulée', 'AbortError');
  if (error) {
    const status = error.context instanceof Response ? error.context.status : undefined;
    if (status === 401) throw new Error('Votre session a expiré. Reconnectez-vous pour retrouver vos missions.');
    if (status === 403 || status === 404) throw new Error('Ce projet ou cette mission n’est pas accessible avec ce compte.');
    if (status === 409) throw new Error('Cette demande ne peut pas être lancée dans l’état actuel. Actualisez les missions.');
    if (status === 429) throw new Error('Trop de demandes rapprochées. Patientez puis réessayez.');
    if (status === 503) throw new Error('Les agents ne sont pas disponibles pour ce projet. Réessayez après leur rétablissement.');
    throw new Error('L’atelier est momentanément injoignable. Votre demande peut avoir été reçue : réessayez sans la modifier.');
  }
  const result = object(data);
  if (result.ok !== true) throw invalid();
  return input.action === 'list' ? parseWorkshopList(result) : parseWorkshopDetail(result.mission);
}

const DRAFT_KEY = 'purama.workshop.draft.v1';
const DRAFT_TTL = 20 * 60_000;
/** A tab-scoped, short-lived handoff across authentication; never placed in the URL. */
export function saveWorkshopDraft(prompt: string, ownerId: string | null, now = Date.now()): void {
  const trimmed = prompt.trim().slice(0, 6000);
  if (!trimmed) return;
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ prompt: trimmed, ownerId, createdAt: now })); } catch { /* Router state still works while signed in. */ }
}
export function consumeWorkshopDraft(userId: string, now = Date.now()): string {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    sessionStorage.removeItem(DRAFT_KEY);
    if (!raw) return '';
    const draft = object(JSON.parse(raw));
    if ((draft.ownerId !== null && draft.ownerId !== userId) || typeof draft.createdAt !== 'number'
      || draft.createdAt > now || now - draft.createdAt > DRAFT_TTL) return '';
    return text(draft.prompt).slice(0, 6000);
  } catch { return ''; }
}
