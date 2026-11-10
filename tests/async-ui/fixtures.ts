import { ACCOUNT_A } from './auth-state';
export function agentFixture(id: string, name: string) {
  return { id, name, user_id: ACCOUNT_A, description: name, emoji: '🤖', tools_enabled: [],
    is_active: true, is_template: false, system_prompt: 'Fixture', model: 'claude-sonnet-4-6',
    temperature: 0.5, category: 'custom', schedule_enabled: false, schedule_cron: null,
    created_at: '2026-11-10T00:00:00Z', updated_at: '2026-11-10T00:00:00Z' };
}
