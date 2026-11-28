import { act, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CreatorAgentNew from './CreatorAgentNew';

const { api, auth, toast } = vi.hoisted(() => ({
  api: { createAgent: vi.fn(), generateAgent: vi.fn() },
  auth: { user: { id: '81000000-0000-4000-8000-000000000001' } },
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('@/lib/creator-agent', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/creator-agent')>(), ...api,
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('sonner', () => ({ toast }));
vi.mock('framer-motion', async () => {
  const React = await import('react');
  type MotionProps = HTMLAttributes<HTMLDivElement> & { initial?: unknown; animate?: unknown };
  return { motion: { div: React.forwardRef<HTMLDivElement, MotionProps>((props, ref) => {
    const attributes = { ...props };
    delete attributes.initial; delete attributes.animate;
    return React.createElement('div', { ...attributes, ref });
  }) } };
});

let root: Root;
let host: HTMLDivElement;
async function fill(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function clickButton(text: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.textContent?.trim() === text);
  expect(button, `Bouton ${text}`).toBeDefined();
  expect(button!.disabled).toBe(false);
  await act(async () => { button!.click(); });
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  api.createAgent.mockImplementation(async (_owner, draft) => ({ id: 'created-agent', ...draft }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<MemoryRouter><CreatorAgentNew /></MemoryRouter>); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('CreatorAgentNew — submitted model', () => {
  it('saves a manual draft with the current default without requiring a model change', async () => {
    const tab = [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find(element => element.textContent?.includes('Mode manuel'))!;
    await act(async () => { tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    const panel = host.querySelector<HTMLElement>('[role="tabpanel"][data-state="active"]')!;
    await fill(panel.querySelector<HTMLInputElement>('input')!, 'Mon agent');
    await fill(panel.querySelector<HTMLTextAreaElement>('textarea')!, 'Tu es un assistant IA utile.');
    await clickButton("Créer l'agent");
    expect(api.createAgent).toHaveBeenCalledExactlyOnceWith(auth.user.id, expect.objectContaining({
      name: 'Mon agent', system_prompt: 'Tu es un assistant IA utile.', model: 'claude-sonnet-4-6',
    }));
    expect(api.generateAgent).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('keeps the generated Haiku choice when saving the preview', async () => {
    api.generateAgent.mockResolvedValue({ name: 'Agent généré', description: 'Aider.', category: 'productivity',
      system_prompt: 'Tu es un assistant IA utile.', suggested_model: 'claude-haiku-4-5-20251001',
      suggested_temperature: 0.3, suggested_tools: [], suggested_schedule: null });
    await fill(host.querySelector<HTMLTextAreaElement>('textarea')!, 'Un agent simple.');
    await clickButton("Générer l'agent");
    await clickButton("Créer l'agent");
    expect(api.generateAgent).toHaveBeenCalledExactlyOnceWith('Un agent simple.');
    expect(api.createAgent).toHaveBeenCalledExactlyOnceWith(auth.user.id, expect.objectContaining({
      name: 'Agent généré', model: 'claude-haiku-4-5-20251001', temperature: 0.3,
    }));
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('Organisation — préparation locale', () => {
  async function openOrganization() {
    await act(async () => root.render(
      <MemoryRouter key="organization-test" initialEntries={['/dashboard/creator-agent/new?mode=organisation']}>
        <CreatorAgentNew />
      </MemoryRouter>,
    ));
  }
  async function choose(select: HTMLSelectElement, value: string) {
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('covers eight families and 64 distinct mission IDs without submitting a request', async () => {
    await openOrganization();
    const [, family, mission] = host.querySelectorAll<HTMLSelectElement>('details select');
    const ids = new Set<string>();
    expect(family.options).toHaveLength(8);
    for (const group of Array.from(family.options)) {
      await choose(family, group.value);
      expect(mission.value).toBe('');
      for (const option of Array.from(mission.options)) {
        if (option.value) ids.add(option.value);
      }
    }
    expect(ids).toEqual(new Set(Array.from({ length: 64 }, (_, i) => String(i + 1))));
    expect(api.createAgent).not.toHaveBeenCalled();
    expect(api.generateAgent).not.toHaveBeenCalled();
  });

  it('preserves a manually edited form and clears it when the active account changes', async () => {
    await openOrganization();
    const panel = host.querySelector<HTMLElement>('[role="tabpanel"][data-state="active"]')!;
    const input = panel.querySelector<HTMLInputElement>('input')!;
    await fill(input, 'Mission privée');
    const mission = host.querySelectorAll<HTMLSelectElement>('details select')[2];
    await choose(mission, '1');
    const prepare = Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Préparer ce brouillon')!;
    expect(prepare.disabled).toBe(true);
    expect(input.value).toBe('Mission privée');
    const previousUser = auth.user;
    try {
      auth.user = { id: '81000000-0000-4000-8000-000000000002' };
      await act(async () => root.render(
        <MemoryRouter key="organization-test"><CreatorAgentNew /></MemoryRouter>,
      ));
      expect(host.querySelector<HTMLInputElement>('input')?.value ?? '').toBe('');
      expect(host.textContent).not.toContain('Mission privée');
    } finally {
      auth.user = previousUser;
    }
    expect(api.createAgent).not.toHaveBeenCalled();
  });

  it.each(['entreprise', 'association'])('prepares an editable, inactive %s agent', async profile => {
    await openOrganization();
    const [context, , mission] = host.querySelectorAll<HTMLSelectElement>('details select');
    await choose(context, profile);
    await choose(mission, '1');
    await clickButton('Préparer ce brouillon');
    const prompt = host.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(prompt.value).toContain(profile === 'association' ? 'fonds affectés' : 'besoin du client');
    expect(prompt.value).toContain('Le distributeur importe le lot et confirme les références acceptées.');
    const prepare = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Préparer ce brouillon');
    expect(prepare?.disabled).toBe(true);
    expect(api.createAgent).not.toHaveBeenCalled();
    expect(api.generateAgent).not.toHaveBeenCalled();
    await fill(prompt, prompt.value + ' Validation interne convenue.');
    await clickButton("Créer l'agent");
    expect(api.createAgent).toHaveBeenCalledExactlyOnceWith(auth.user.id, expect.objectContaining({
      is_active: false, is_public: false, karta_enabled: false, schedule_enabled: false,
      schedule_cron: null, tools_enabled: [], system_prompt: expect.stringContaining('Validation interne convenue.'),
    }));
  });
});
