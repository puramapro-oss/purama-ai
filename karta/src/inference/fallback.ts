import type { InferenceProvider } from "./types.js";

export function withOptInFallback(primary: InferenceProvider, fallback?: InferenceProvider): InferenceProvider {
  if (!fallback) return primary;
  return {
    isMock: primary.isMock && fallback.isMock,
    async decide(input) {
      try {
        return await primary.decide(input);
      } catch (primaryError) {
        console.error(`[inference] fournisseur principal indisponible, fallback explicite active: ${messageOf(primaryError)}`);
        return fallback.decide(input);
      }
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
