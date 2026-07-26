import { config } from "../config.js";
import { createMockClaudeClient } from "./mock.js";
import { createRealClaudeClient } from "./real.js";
import type { ClaudeClient } from "./types.js";

export type { ClaudeClient, ClaudeDecideInput } from "./types.js";

let cached: ClaudeClient | null = null;

/** Sélectionne le mock ou le vrai client selon KARTA_MOCK_CLAUDE (cf .env.example). */
export function getClaudeClient(): ClaudeClient {
  if (!cached) {
    cached = config.mockClaude ? createMockClaudeClient() : createRealClaudeClient();
  }
  return cached;
}
