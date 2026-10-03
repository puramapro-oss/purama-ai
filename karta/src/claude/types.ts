import type { InferenceInput, InferenceProvider } from "../inference/types.js";

/** Alias conserves pour compatibilite avec les appels et tests existants. */
export type ClaudeDecideInput = InferenceInput;
export type ClaudeClient = InferenceProvider;
