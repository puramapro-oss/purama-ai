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
export interface WorkshopArtifact {
  missionId: string;
  commitSha: string;
  archive: { fileName: string; mediaType: 'application/zip'; data: Uint8Array; sha256: string; bytes: number };
  preview?: { fileName: string; mediaType: 'text/html'; content: string; sha256: string; bytes: number };
}
type WorkshopRequest =
  | { action: 'list' }
  | { action: 'status' | 'cancel'; missionId: string }
  | { action: 'start'; projectId: string; prompt: string; requestId: string };
type WorkshopArtifactRequest = { action: 'artifact'; missionId: string };
export const WORKSHOP_ARCHIVE_LIMIT = 4 * 1024 * 1024;
export const WORKSHOP_PREVIEW_LIMIT = 200 * 1024;

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

async function invokeWorkshop(input: WorkshopRequest | WorkshopArtifactRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
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
  return result;
}
export async function requestWorkshop(input: { action: 'list' }, signal?: AbortSignal): Promise<WorkshopList>;
export async function requestWorkshop(input: Exclude<WorkshopRequest, { action: 'list' }>, signal?: AbortSignal): Promise<WorkshopDetail>;
export async function requestWorkshop(input: WorkshopRequest, signal?: AbortSignal): Promise<WorkshopList | WorkshopDetail> {
  const result = await invokeWorkshop(input, signal);
  return input.action === 'list' ? parseWorkshopList(result) : parseWorkshopDetail(result.mission);
}

function sha256(value: unknown): string {
  const hash = text(value, 64);
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw invalid();
  return hash.toLowerCase();
}
function artifactFileName(value: unknown, extension: 'zip' | 'html'): string {
  const name = text(value, 160);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name) || !name.toLowerCase().endsWith('.' + extension)) throw invalid();
  return name;
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Requête annulée', 'AbortError');
}
async function verifyDigest(data: Uint8Array, expected: string, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  if (!globalThis.crypto?.subtle) throw new Error('La vérification des fichiers nécessite une connexion HTTPS sécurisée.');
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data).buffer);
  checkAbort(signal);
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== expected) throw new Error('Les fichiers reçus ne correspondent pas à leur empreinte. Réessayez le chargement.');
}
/** Verify identity and bytes before making generated content available to the browser. */
export async function parseWorkshopArtifact(value: unknown, expected: { missionId: string; commitSha: string }, signal?: AbortSignal): Promise<WorkshopArtifact> {
  checkAbort(signal);
  const item = object(value);
  const missionId = uuid(item.missionId);
  const commitSha = text(item.commitSha, 64).toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commitSha)
    || missionId.toLowerCase() !== expected.missionId.toLowerCase() || commitSha !== expected.commitSha.toLowerCase()) throw invalid();
  const rawArchive = object(item.archive);
  const bytes = count(rawArchive.bytes);
  if (bytes === 0 || bytes > WORKSHOP_ARCHIVE_LIMIT || rawArchive.mediaType !== 'application/zip'
    || typeof rawArchive.base64 !== 'string' || rawArchive.base64.length !== 4 * Math.ceil(bytes / 3)
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(rawArchive.base64)) throw invalid();
  const fileName = artifactFileName(rawArchive.fileName, 'zip');
  const hash = sha256(rawArchive.sha256);
  let decoded: string;
  try { decoded = atob(rawArchive.base64); } catch { throw invalid(); }
  if (decoded.length !== bytes || btoa(decoded) !== rawArchive.base64) throw invalid();
  const data = Uint8Array.from(decoded, character => character.charCodeAt(0));
  await verifyDigest(data, hash, signal);
  const result: WorkshopArtifact = { missionId, commitSha, archive: { fileName, mediaType: 'application/zip', data, sha256: hash, bytes } };
  if (item.preview !== undefined) {
    const rawPreview = object(item.preview);
    const previewBytes = count(rawPreview.bytes);
    if (previewBytes === 0 || previewBytes > WORKSHOP_PREVIEW_LIMIT || rawPreview.mediaType !== 'text/html'
      || typeof rawPreview.content !== 'string' || rawPreview.content.length > WORKSHOP_PREVIEW_LIMIT || rawPreview.content.includes('\0')) throw invalid();
    const previewData = new TextEncoder().encode(rawPreview.content);
    if (previewData.byteLength !== previewBytes) throw invalid();
    const previewHash = sha256(rawPreview.sha256);
    await verifyDigest(previewData, previewHash, signal);
    result.preview = { fileName: artifactFileName(rawPreview.fileName, 'html'), mediaType: 'text/html', content: rawPreview.content, sha256: previewHash, bytes: previewBytes };
  }
  return result;
}
export async function requestWorkshopArtifact(mission: WorkshopDetail, signal?: AbortSignal): Promise<WorkshopArtifact> {
  const implementation = mission.tasks.filter(task => task.key === 'implementation' && task.state === 'verified_done');
  if (mission.state !== 'verified_done' || mission.verifiedTasks !== mission.totalTasks
    || implementation.length !== 1 || !implementation[0].outputSha) throw invalid();
  const result = await invokeWorkshop({ action: 'artifact', missionId: mission.id }, signal);
  return parseWorkshopArtifact(result.artifact, { missionId: mission.id, commitSha: implementation[0].outputSha }, signal);
}

/** The opaque iframe also excludes same-origin, forms, popups, top navigation and downloads. */
export function workshopPreviewDocument(content: string): string {
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  // The trusted policy precedes every untrusted token. A later meta policy can only restrict it further.
  return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + policy
    + '"><meta name="referrer" content="no-referrer">' + content;
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
