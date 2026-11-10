// Re-export the canonical, dependency-free policy. No copied prompt to drift.
// Keep the relative dependency when bundling a Supabase function from this repo.
export {
  ASSISTANT_POLICY_VERSION,
  ASSISTANT_CORE_POLICY,
  WELLBEING_CONVERSATION_POLICY,
  buildAssistantSystemPrompt,
} from '../../../karta/src/claude/assistant-policy.ts';
