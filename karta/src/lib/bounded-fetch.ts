/**
 * Fetch borné partagé (P0 IAO 2026-09-26, sous-lot 7).
 *
 * Les outils KARTA passent déjà par `withToolTimeout` (30s, Promise.race) via
 * executeToolStrict — mais la race ABANDONNE sans annuler : le socket du fetch restait
 * vivant en arrière-plan (zombie) jusqu'au timeout TCP natif (~5min undici). Un AbortSignal
 * ferme RÉELLEMENT la connexion et rejette proprement.
 *
 * 25s par défaut, VOLONTAIREMENT sous TOOL_TIMEOUT_MS (30s) : l'abort natif gagne la course
 * → l'échec journalisé porte un message d'abort explicite plutôt que le timeout générique
 * de la race, et le socket meurt avec. Note : tout init.signal fourni par l'appelant est
 * écrasé (hard ceiling voulu — aucun tool ne passe de signal aujourd'hui).
 */

/** Défaut des appels d'outils tiers — rester sous les 30s de withToolTimeout (tool-result.ts). */
export const TOOL_FETCH_TIMEOUT_MS = 25_000;

export function fetchWithTimeout(
  url: string | URL,
  init?: RequestInit,
  timeoutMs: number = TOOL_FETCH_TIMEOUT_MS
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
