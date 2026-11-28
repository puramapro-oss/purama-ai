import type { AgentCategory } from '@/lib/creator-agent';

/** The public contract deliberately has no owner, prompt, history or schedule input. */
export interface PublicCreatorModel {
  id: string;
  name: string;
  description: string | null;
  emoji: string;
  color: string;
  category: AgentCategory | null;
  is_public: boolean;
  is_template: boolean;
  is_active: true;
}

export function isCreatorModelId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

const categories = new Set<AgentCategory>([
  'productivity', 'marketing', 'sales', 'support', 'content', 'dev', 'finance', 'autre',
]);

function boundedText(value: string, limit: number): string {
  const chars = Array.from(value.trim());
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : chars.join('');
}

/** Defense in depth: never spread a server record into public UI state. */
export function parsePublicCreatorModel(value: unknown): PublicCreatorModel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!isCreatorModelId(row.id) || typeof row.name !== 'string' || !row.name.trim()) return null;
  if (row.is_active !== true || (row.is_public !== true && row.is_template !== true)) return null;
  if (typeof row.is_public !== 'boolean' || typeof row.is_template !== 'boolean') return null;
  return {
    id: row.id.toLowerCase(),
    name: boundedText(row.name, 160),
    description: typeof row.description === 'string' && row.description.trim()
      ? boundedText(row.description, 1600) : null,
    emoji: typeof row.emoji === 'string' && row.emoji.length <= 32 && row.emoji.trim()
      ? row.emoji : '🤖',
    color: typeof row.color === 'string' && /^#[0-9a-f]{6}$/i.test(row.color)
      ? row.color : '#8B5CF6',
    category: categories.has(row.category as AgentCategory) ? row.category as AgentCategory : null,
    is_public: row.is_public,
    is_template: row.is_template,
    is_active: true,
  };
}
