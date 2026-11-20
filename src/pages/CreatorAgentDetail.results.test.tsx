import { act, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CreatorAgentDetail from './CreatorAgentDetail';
import type { CreatorAgent } from '@/lib/creator-agent';
import type { PrivateToolResult } from '@/lib/private-tool-results';

const { auth, api, resultApi, voice, toast } = vi.hoisted(() => ({
  auth: { user: null as { id: string } | null },
  api: {
    getAgent: vi.fn(), updateAgent: vi.fn(), deleteAgent: vi.fn(), chatWithAgent: vi.fn(),
    listChatMessages: vi.fn(), listRuns: vi.fn(), newSessionId: vi.fn(),
  },
  resultApi: { listPrivateToolResults: vi.fn(), deletePrivateToolResult: vi.fn() },
  voice: { cancelRecording: vi.fn(), stopSpeaking: vi.fn() },
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('@/hooks/useVoice', () => ({ useVoice: () => voice }));
vi.mock('@/components/voice/MicButton', () => ({ MicButton: () => null }));
vi.mock('@/components/voice/SpeakButton', () => ({ SpeakButton: () => null }));
vi.mock('@/components/voice/VoiceMode', () => ({ VoiceMode: () => null }));
vi.mock('@/components/karta/PendingActionsList', () => ({ PendingActionsList: () => null }));
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
vi.mock('@/lib/private-tool-results', () => resultApi);
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
const OTHER_OWNER = '81000000-0000-4000-8000-000000000002';
const AGENT = '82000000-0000-4000-8000-000000000001';
const OTHER_AGENT = '82000000-0000-4000-8000-000000000002';
const RESULT = '83000000-0000-4000-8000-000000000001';
const at = '2026-11-12T10:00:00.000Z';
function agentFor(id: string, owner: string | null): CreatorAgent {
  return {
    id, user_id: owner, name: 'Mon assistant', slug: 'mon-assistant', description: null,
    emoji: '🤖', color: '#8B5CF6', category: 'productivity', system_prompt: 'Aider',
    model: 'claude-sonnet-4-20250514', temperature: 0.5, max_tokens: 1024,
    tools_enabled: [], schedule_enabled: false, schedule_cron: null, schedule_input: null,
    last_scheduled_run: null, karta_enabled: true, is_active: true, is_public: false,
    is_template: false, total_runs: 0, total_tokens: 0, avg_rating: null,
    cloned_from: null, created_at: at, updated_at: at,
  };
}
function resultFor(owner = OWNER, agent = AGENT): PrivateToolResult {
  return {
    id: RESULT, run_id: '84000000-0000-4000-8000-000000000001', user_id: owner,
    creator_agent_id: agent, tool_name: 'quantum_simulate', created_at: at,
    payload: {
      schema_version: 1, tool_name: 'quantum_simulate', status: 'complete',
      summary: 'Simulation locale terminée, sans QPU.', sources: [],
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

let root: Root | null;
let host: HTMLDivElement;
let navigate: NavigateFunction;
let scrollDescriptor: PropertyDescriptor | undefined;
function Harness() {
  navigate = useNavigate();
  return <Routes><Route path="/agents/:id" element={<CreatorAgentDetail />} /></Routes>;
}
async function render() {
  await act(async () => { root?.render(<MemoryRouter initialEntries={[`/agents/${AGENT}`]}><Harness /></MemoryRouter>); });
}
function button(text: string) {
  const found = [...host.querySelectorAll('button')].find(element => element.textContent?.trim() === text);
  if (!found) throw new Error(`Bouton absent : ${text}`);
  return found;
}
async function click(text: string) { await act(async () => { button(text).click(); }); }
async function openResults() {
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(element => element.textContent?.includes('Runs'));
  if (!tab) throw new Error('Onglet Runs absent');
  await act(async () => { tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
}
async function selectResult() {
  await openResults();
  const input = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!input) throw new Error('Sélection de résultat absente');
  await act(async () => { input.click(); });
  await click('Poser une question avec ces résultats');
}
function textarea() {
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Question pour Mon assistant"]');
  if (!input) throw new Error('Zone de question absente');
  return input;
}
async function send(text = 'Explique ce résultat') {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea(), text);
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Envoyer la question"]')?.click(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.user = { id: OWNER };
  api.getAgent.mockReset().mockImplementation(async (id: string) => agentFor(id, auth.user?.id ?? null));
  api.listChatMessages.mockReset().mockResolvedValue([]);
  api.listRuns.mockReset().mockResolvedValue([]);
  api.chatWithAgent.mockReset().mockResolvedValue({ reply: 'Synthèse actuelle.', tokens: 12 });
  let nextSession = 0;
  api.newSessionId.mockReset().mockImplementation(() => `85000000-0000-4000-8000-${String(++nextSession).padStart(12, '0')}`);
  resultApi.listPrivateToolResults.mockReset().mockImplementation(async (owner: string, agent: string) => [resultFor(owner, agent)]);
  resultApi.deletePrivateToolResult.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null; host.remove();
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('CreatorAgentDetail — résultat privé vers question', () => {
  it('ouvre le composeur au clavier et joint uniquement les IDs à un seul envoi explicite', async () => {
    await render();
    await selectResult();
    expect(document.activeElement).toBe(textarea());
    expect(api.chatWithAgent).not.toHaveBeenCalled();
    expect(host.textContent).toContain('1 résultat privé sera joint');
    await send();
    const args = api.chatWithAgent.mock.calls[0];
    expect(args).toEqual([AGENT, expect.any(String), 'Explique ce résultat', expect.any(AbortSignal), [RESULT]]);
    expect(api.chatWithAgent).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('Synthèse actuelle.');
    expect(host.textContent).not.toContain('résultat privé sera joint');
    await send('Question suivante');
    expect(api.chatWithAgent.mock.calls[1]).toHaveLength(4);
  });

  it('garde la sélection après un échec et la retire après la réussite de la nouvelle tentative', async () => {
    api.chatWithAgent.mockRejectedValueOnce(new Error('Échec temporaire'));
    await render(); await selectResult(); await send();
    expect(host.textContent).toContain('1 résultat privé sera joint');
    expect(toast.error).toHaveBeenCalledOnce();
    await send('Réessaie cette synthèse');
    expect(api.chatWithAgent.mock.calls[1][4]).toEqual([RESULT]);
    expect(host.textContent).not.toContain('résultat privé sera joint');
  });

  it('ne laisse pas une réponse ancienne supprimer la sélection du compte revenu après A → B → A', async () => {
    const pending = deferred<{ reply: string; tokens: number }>();
    api.chatWithAgent.mockReturnValueOnce(pending.promise);
    await render(); await selectResult(); await send();
    const originalSignal = api.chatWithAgent.mock.calls[0][3] as AbortSignal;
    auth.user = { id: OTHER_OWNER }; await render();
    auth.user = { id: OWNER }; await render();
    expect(host.textContent).not.toContain('résultat privé sera joint');
    await selectResult();
    await act(async () => { pending.resolve({ reply: 'RÉPONSE PÉRIMÉE', tokens: 1 }); });
    expect(originalSignal.aborted).toBe(true);
    expect(host.textContent).not.toContain('RÉPONSE PÉRIMÉE');
    expect(host.textContent).toContain('1 résultat privé sera joint');
    expect(textarea().disabled).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('oublie la sélection lors d’un changement d’agent et conserve le contrat du chat sans pièce jointe', async () => {
    await render(); await selectResult();
    await act(async () => { navigate(`/agents/${OTHER_AGENT}`); });
    expect(host.textContent).not.toContain('résultat privé sera joint');
    await send('Question à un autre agent');
    expect(api.chatWithAgent.mock.calls[0][0]).toBe(OTHER_AGENT);
    expect(api.chatWithAgent.mock.calls[0]).toHaveLength(4);
  });

  it('retire de la sélection le résultat dont le propriétaire confirme la suppression', async () => {
    await render(); await selectResult();
    await click('Modifier la sélection');
    await click('Supprimer'); await click('Confirmer la suppression');
    expect(host.textContent).toContain('Aucun résultat joint');
    expect(host.textContent).not.toContain('Poser une question avec ces résultats');
    expect(api.chatWithAgent).not.toHaveBeenCalled();
  });

  it('ne charge pas de résultats privés pour un modèle consulté en lecture seule', async () => {
    api.getAgent.mockResolvedValue(agentFor(AGENT, null));
    await render(); await openResults();
    expect(resultApi.listPrivateToolResults).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('Résultats privés de cet agent');
  });
});
