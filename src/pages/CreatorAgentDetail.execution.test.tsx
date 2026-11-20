import { act, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CreatorAgentDetail from './CreatorAgentDetail';
import type { CreatorAgent } from '@/lib/creator-agent';

const { auth, api, voice, toast } = vi.hoisted(() => ({
  auth: { user: null as { id: string } | null },
  api: {
    getAgent: vi.fn(), updateAgent: vi.fn(), deleteAgent: vi.fn(), chatWithAgent: vi.fn(),
    listChatMessages: vi.fn(), listRuns: vi.fn(), newSessionId: vi.fn(),
  },
  voice: { cancelRecording: vi.fn(), stopSpeaking: vi.fn() },
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('@/hooks/useVoice', () => ({ useVoice: () => voice }));
vi.mock('@/components/voice/MicButton', () => ({ MicButton: () => null }));
vi.mock('@/components/voice/SpeakButton', () => ({ SpeakButton: () => null }));
vi.mock('@/components/voice/VoiceMode', () => ({ VoiceMode: () => null }));
vi.mock('@/components/karta/PendingActionsList', () => ({ PendingActionsList: () => null }));
vi.mock('@/components/karta/PrivateToolResults', () => ({ PrivateToolResults: () => null }));
vi.mock('@/hooks/useCreatorAgentKarta', () => ({
  useCustomAgentKartaState: () => ({ data: null, isError: false }),
  useUpdateCustomAgentKartaState: () => ({ isPending: false }),
  useCustomAgentKartaRuns: () => ({ data: [] }),
  useTriggerCustomAgent: () => ({ isPending: false }),
  useCustomAgentPendingActions: () => ({ data: [] }),
}));
vi.mock('@/lib/creator-agent', () => ({
  ...api, CATEGORIES: [], MODELS: [], TOOL_OPTIONS: [], SCHEDULE_PRESETS: [],
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('framer-motion', async () => {
  const React = await import('react');
  type MotionProps = HTMLAttributes<HTMLDivElement> & {
    initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown;
  };
  return { motion: { div: React.forwardRef<HTMLDivElement, MotionProps>((props, ref) => {
    const attributes = { ...props };
    delete attributes.initial; delete attributes.animate; delete attributes.exit; delete attributes.transition;
    return React.createElement('div', { ...attributes, ref });
  }) } };
});

const OWNER = '81000000-0000-4000-8000-000000000001';
const AGENT = '82000000-0000-4000-8000-000000000001';
const OTHER = '82000000-0000-4000-8000-000000000002';
function fixture(id = AGENT): CreatorAgent {
  return {
    id, user_id: OWNER, name: 'Mon assistant', slug: 'mon-assistant', description: null,
    emoji: '🤖', color: '#8B5CF6', category: 'productivity', system_prompt: 'Aider',
    model: 'claude-sonnet-4-20250514', temperature: 0.5, max_tokens: 4000,
    execution_preferences: { reflection: 'deep', speed: 'fast' },
    tools_enabled: [], schedule_enabled: false, schedule_cron: null, schedule_input: null,
    last_scheduled_run: null, karta_enabled: true, is_active: true, is_public: false,
    is_template: false, total_runs: 0, total_tokens: 0, avg_rating: null,
    cloned_from: null, created_at: '2026-11-12T10:00:00Z', updated_at: '2026-11-12T10:00:00Z',
  };
}

let root: Root;
let host: HTMLDivElement;
let navigate: NavigateFunction;
let records: Record<string, CreatorAgent>;
let scrollDescriptor: PropertyDescriptor | undefined;
let scrollToDescriptor: PropertyDescriptor | undefined;
function Harness() {
  navigate = useNavigate();
  return <Routes><Route path="/agents/:id" element={<CreatorAgentDetail />} /></Routes>;
}
async function render() {
  await act(async () => { root.render(<MemoryRouter initialEntries={[`/agents/${AGENT}`]}><Harness /></MemoryRouter>); });
}
async function settings() {
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(element => element.textContent?.includes('Paramètres'));
  if (!tab) throw new Error('Onglet Paramètres absent');
  await act(async () => { tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
}
async function choose(id: string, label: string) {
  const trigger = host.querySelector<HTMLButtonElement>(`#${id}`);
  if (!trigger) throw new Error(`Contrôle absent : ${id}`);
  await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(element => element.textContent === label);
  if (!option) throw new Error(`Option absente : ${label}`);
  await act(async () => { option.click(); });
}
async function save() {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.trim() === 'Enregistrer');
  if (!button) throw new Error('Bouton Enregistrer absent');
  await act(async () => { button.click(); });
}

beforeEach(() => {
  vi.resetAllMocks();
  auth.user = { id: OWNER };
  records = { [AGENT]: fixture(), [OTHER]: { ...fixture(OTHER), execution_preferences: { reflection: 'standard', speed: 'standard' } } };
  api.getAgent.mockImplementation(async (id: string) => structuredClone(records[id]));
  api.updateAgent.mockImplementation(async (id: string, patch: CreatorAgent) => {
    records[id] = structuredClone(patch);
    return structuredClone(records[id]);
  });
  api.listChatMessages.mockResolvedValue([]);
  api.listRuns.mockResolvedValue([]);
  api.newSessionId.mockReturnValue('85000000-0000-4000-8000-000000000001');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  if (scrollToDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollToDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('CreatorAgentDetail — real task preference controls', () => {
  it('loads, edits, saves and reloads both choices without changing model or chat settings', async () => {
    await render(); await settings();
    expect(host.querySelector('#agent-reflection')?.textContent).toBe('Approfondie');
    expect(host.querySelector('#agent-execution-speed')?.textContent).toBe('Rapide');
    expect(host.querySelector('#agent-execution-help')?.textContent).toContain('sans garantir un délai');
    await choose('agent-reflection', 'Maximale');
    await choose('agent-execution-speed', 'Ultra rapide');
    await save();
    expect(api.updateAgent).toHaveBeenCalledExactlyOnceWith(AGENT, expect.objectContaining({
      model: 'claude-sonnet-4-20250514', temperature: 0.5, max_tokens: 4000,
      execution_preferences: { reflection: 'maximum', speed: 'ultra_fast' },
    }));
    expect(api.chatWithAgent).not.toHaveBeenCalled();
    await act(async () => { navigate(`/agents/${OTHER}`); });
    await act(async () => { navigate(`/agents/${AGENT}`); });
    await settings();
    expect(host.querySelector('#agent-reflection')?.textContent).toBe('Maximale');
    expect(host.querySelector('#agent-execution-speed')?.textContent).toBe('Ultra rapide');
  });

  it('shows legacy defaults without adding preferences to an unrelated save', async () => {
    delete records[AGENT].execution_preferences;
    await render(); await settings();
    expect(host.querySelector('#agent-reflection')?.textContent).toBe('Automatique (standard)');
    expect(host.querySelector('#agent-execution-speed')?.textContent).toBe('Standard');
    await save();
    expect(api.updateAgent.mock.calls[0][1]).not.toHaveProperty('execution_preferences');
    await choose('agent-reflection', 'Approfondie'); await save();
    expect(api.updateAgent.mock.calls[1][1].execution_preferences).toEqual({ reflection: 'deep', speed: 'standard' });
  });

  it('keeps foreign or template settings read-only', async () => {
    records[AGENT].user_id = OTHER;
    await render(); await settings();
    expect(host.querySelector<HTMLButtonElement>('#agent-reflection')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('#agent-execution-speed')?.disabled).toBe(true);
    expect(api.updateAgent).not.toHaveBeenCalled();
  });

  it('does not display an old save response on another agent', async () => {
    let resolve!: (agent: CreatorAgent) => void;
    api.updateAgent.mockReturnValueOnce(new Promise<CreatorAgent>(accept => { resolve = accept; }));
    await render(); await settings(); await choose('agent-reflection', 'Maximale'); await save();
    const oldSave = api.updateAgent.mock.calls[0][1] as CreatorAgent;
    await act(async () => { navigate(`/agents/${OTHER}`); });
    await settings();
    await act(async () => { resolve(oldSave); });
    expect(host.querySelector('#agent-reflection')?.textContent).toBe('Standard');
    expect(host.querySelector('#agent-execution-speed')?.textContent).toBe('Standard');
    expect(toast.success).not.toHaveBeenCalled();
  });
});
