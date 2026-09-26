/**
 * Contrat formel des résultats d'outils KARTA (P0 2026-09-26).
 *
 * Avant ce contrat, loop.ts et approval.ts décidaient succès/échec uniquement sur le fait que
 * execute() avait levé ou non : un outil retournant `false`, `{ ok: false }`, `{ success: false }`
 * ou `{ error: "..." }` SANS lever était journalisé `success: true` / `executed` — un faux succès
 * (email "envoyé" qui ne l'était pas, action approuvée marquée exécutée à tort).
 *
 * `executeToolStrict()` ci-dessous est l'UNIQUE point d'exécution des outils : timeout + cast
 * d'effacement + classification + résumé, au même endroit pour le cycle et l'approbation.
 *
 * Classification (source de vérité unique, partagée cycle + approbation) :
 * - exception levée           → échec (déjà géré par les try/catch appelants)
 * - `undefined` / `null`      → void légitime → SUCCÈS (un outil `Promise<void>` n'a rien à dire)
 * - `false`                   → échec implicite strict → ÉCHEC
 * - `true` / toute autre valeur → SUCCÈS (donnée, tableau vide, nombre, chaîne...)
 * - objet avec `ok === false` ou `success === false` → ÉCHEC (message extrait si possible)
 * - objet avec `error` chaîne non vide (sans ok/success true) → ÉCHEC
 * - objet avec `status === "error"` (sans ok/success true) → ÉCHEC
 *
 * Le strict par défaut (false = échec) est volontaire : un faux échec remonte à l'humain et aux
 * logs, un faux succès cache une action cassée. Un outil qui doit retourner un booléen comme
 * DONNÉE l'enveloppe (`{ value: false }`).
 */

import { callErasedTool } from "./types.js";
import type { AnyToolDefinition, ToolExecutionContext } from "./types.js";

/** Résultat d'outil signalant un échec sans lever d'exception. */
export class ToolResultError extends Error {
  constructor(
    message: string,
    /** Valeur brute retournée par l'outil, pour diagnostic — jamais sérialisée telle quelle
     * dans les logs si elle est volumineuse (le message porte déjà l'essentiel). */
    readonly result: unknown
  ) {
    super(message);
    this.name = "ToolResultError";
  }
}

/** Opération trop lente (générique — sert aussi bien decide() qu'un outil). */
export class TimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} : timeout après ${timeoutMs}ms — exécution abandonnée`);
    this.name = "TimeoutError";
  }
}

/** Outil trop lent — traité comme un échec d'exécution, jamais comme un succès silencieux. */
export class ToolTimeoutError extends ToolResultError {
  constructor(toolName: string, timeoutMs: number) {
    super(`${toolName} : timeout après ${timeoutMs}ms — exécution abandonnée`, null);
    this.name = "ToolTimeoutError";
  }
}

/** Timeout par défaut d'une exécution d'outil. Aucun outil KARTA légitime ne dépasse quelques
 * secondes ; 30s couvre les uploads PDF et les APIs tierces lentes sans laisser un cycle bloqué
 * à l'infini (avant ce contrat, un fetch pendant figeait le worker BullMQ). */
export const TOOL_TIMEOUT_MS = 30_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extrait un message d'échec lisible d'une enveloppe objet. */
function extractErrorMessage(envelope: Record<string, unknown>): string | null {
  for (const key of ["error", "message", "reason", "detail"]) {
    const value = envelope[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/**
 * Vérifie qu'un résultat d'outil ne signale pas un échec ; lève ToolResultError sinon.
 * À appeler immédiatement après execute() : l'erreur levée suit le chemin catch existant de
 * l'appelant (success:false / status "failed"), sans duplication de logique.
 */
export function assertToolResult(result: unknown): void {
  if (result === null || result === undefined) return; // void légitime
  if (result === false) {
    throw new ToolResultError("l'outil a retourné `false` (échec implicite — envelopper les booléens-réponse dans { value })", result);
  }
  if (!isPlainObject(result)) return; // true, nombre, chaîne, tableau : donnée brute = succès

  // Enveloppes explicites : ok/success font autorité quand présents.
  if (result.ok === false || result.success === false) {
    throw new ToolResultError(extractErrorMessage(result) ?? `l'outil a retourné une enveloppe d'échec (${JSON.stringify(result).slice(0, 120)})`, result);
  }
  if (result.ok === true || result.success === true) return;

  // Enveloppes implicites : error chaîne non vide, ou status "error".
  const explicitMessage = extractErrorMessage(result);
  if (explicitMessage !== null && result.status !== "ok" && result.status !== "success") {
    throw new ToolResultError(explicitMessage, result);
  }
  if (result.status === "error") {
    throw new ToolResultError(extractErrorMessage(result) ?? 'l\'outil a retourné { status: "error" }', result);
  }
}

/** Résumé sérialisable d'un résultat (≤200 caractères), ne lève JAMAIS (objets circulaires, getters qui throw...). */
export function summarizeToolResult(result: unknown): string {
  if (result === undefined || result === null) return "ok (sans résultat)";
  if (typeof result === "string") return result.slice(0, 200);
  try {
    return JSON.stringify(result).slice(0, 200); // undefined (fn/symbol) → throw → non sérialisable
  } catch {
    return "ok (résultat non sérialisable)";
  }
}

/**
 * Borne une opération dans le temps (mécanisme générique — un outil OU l'appel decide() du
 * provider). Limite assumée : le Promise.race n'interrompt pas l'opération sous-jacente (pas
 * d'AbortSignal dans les contrats) — la promesse orpheline continue en arrière-plan mais
 * l'appelant, lui, reprend la main et journalise l'échec timeout.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number,
  makeError: (label: string, timeoutMs: number) => Error
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    // Timer désarmé dès que la course est décidée (finally) : un timer vivant maintiendrait
    // la boucle d'événements (et donc le process) éveillée jusqu'à 30s après la résolution.
    timer = setTimeout(() => reject(makeError(label, timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Variante outil de withTimeout : le timeout est un ToolResultError (même chemin de catch
 * que les échec de contrat — un outil trop lent est un échec d'exécution, pas un succès). */
export function withToolTimeout<T>(promise: Promise<T>, toolName: string, timeoutMs: number = TOOL_TIMEOUT_MS): Promise<T> {
  return withTimeout(promise, toolName, timeoutMs, (label, ms) => new ToolTimeoutError(label, ms));
}

/**
 * Exécute un outil effacé en appliquant LE contrat complet — unique point d'exécution des
 * outils KARTA, partagé par le cycle (engine/loop.ts) et l'approbation humaine
 * (engine/approval.ts) : timeout (30s par défaut) + cast d'effacement (callErasedTool) +
 * assertToolResult (faux succès interdits) + résumé sérialisable. Lève en cas d'échec ;
 * retourne uniquement le résumé (les 2 appelants ne consomment jamais la valeur brute).
 */
export async function executeToolStrict(
  tool: AnyToolDefinition,
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<string> {
  const result = await withToolTimeout(callErasedTool(tool, params, ctx), tool.name);
  assertToolResult(result);
  return summarizeToolResult(result);
}
