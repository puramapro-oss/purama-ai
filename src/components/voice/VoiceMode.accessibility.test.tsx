import { act, type HTMLAttributes, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { UseVoice } from '@/hooks/useVoice';
import { sendAgentChatMessage } from '@/lib/agent-chat';
import { AgentChatTab } from './AgentChatTab';
import { VoiceMode } from './VoiceMode';

const fixture = vi.hoisted(() => ({
  reducedMotion: false,
  voice: null as unknown as UseVoice,
  user: { id: '00000000-0000-4000-8000-000000000001' },
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: fixture.user }) }));
vi.mock('@/hooks/useVoice', () => ({ useVoice: () => fixture.voice }));
vi.mock('@/lib/agent-chat', () => ({
  newAgentSessionId: () => '00000000-0000-4000-8000-000000000002',
  listAgentChatMessages: vi.fn(async () => []),
  sendAgentChatMessage: vi.fn(async () => ({ reply: 'Bonjour', tokens: 1 })),
}));

// Real React and Radix focus management. Replace decorative animation only;
// these DOM tests do not claim browser layout or assistive-technology coverage.
vi.mock('framer-motion', async () => {
  const React = await import('react');
  type MotionProps = HTMLAttributes<HTMLElement> & {
    initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown;
  };
  function element(tag: 'div' | 'p' | 'span') {
    return React.forwardRef<HTMLElement, MotionProps>((props, ref) => {
      const attributes = { ...props };
      delete attributes.initial;
      delete attributes.animate;
      delete attributes.exit;
      delete attributes.transition;
      return React.createElement(tag, { ...attributes, ref });
    });
  }
  return {
    motion: { div: element('div'), p: element('p'), span: element('span') },
    AnimatePresence: ({ children }: PropsWithChildren) => children,
    useReducedMotion: () => fixture.reducedMotion,
  };
});

let host: HTMLDivElement;
let previousControl: HTMLButtonElement;
let root: Root;
let open: boolean;
type SendReply = (text: string, signal?: AbortSignal) => Promise<string | null>;
let onClose: Mock<() => void>;
let onSend: Mock<SendReply>;
const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
const scrollTo = vi.fn();

function button(name: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!found) throw new Error(`Missing accessible button: ${name}`);
  return found;
}

async function renderVoice() {
  await act(async () => root.render(
    <VoiceMode open={open} onClose={onClose} voice={fixture.voice} agentName="IA de test" onSend={onSend} />,
  ));
}

async function press(target: HTMLElement, key: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}

async function settleClose() {
  // Radix restores focus in its documented unmount task, after the portal closes.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
}

async function finishTranscription() {
  await act(async () => button('Activer le micro').click());
  fixture.voice = { ...fixture.voice, isRecording: true };
  await renderVoice();
  await act(async () => button("Terminer l'enregistrement").click());
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.reducedMotion = false;
  fixture.voice = {
    isRecording: false, isTranscribing: false, isSpeaking: false, audioLevel: 0,
    startRecording: vi.fn(async () => {}),
    stopRecording: vi.fn(async () => 'Une question'),
    cancelRecording: vi.fn(), speak: vi.fn(async () => {}), stopSpeaking: vi.fn(),
    settings: { provider: 'openai', voice_id: 'nova', speed: 1, auto_play: false, enabled: true, language: 'fr' },
    updateSettings: vi.fn(async () => {}), loadingSettings: false,
  };
  scrollTo.mockClear();
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
  previousControl = document.createElement('button');
  previousControl.textContent = 'Ouvrir le mode vocal';
  document.body.append(previousControl);
  previousControl.focus();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  open = true;
  onSend = vi.fn<SendReply>(async () => 'Une réponse');
  onClose = vi.fn(() => { open = false; });
});

afterEach(async () => {
  await act(async () => root.unmount());
  await settleClose();
  host.remove();
  previousControl.remove();
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('VoiceMode: semantics and keyboard integration', () => {
  it('opens one named modal, focuses its close control and starts no capture or playback', async () => {
    await renderVoice();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(dialog!.getAttribute('aria-labelledby')!);
    expect(title?.textContent).toMatch(/Mode vocal.*IA de test/);
    expect(document.getElementById(dialog!.getAttribute('aria-describedby')!)?.textContent).toBeTruthy();
    expect(document.activeElement).toBe(button('Fermer le mode vocal'));
    expect(previousControl.getAttribute('aria-hidden')).toBe('true');
    expect(fixture.voice.startRecording).not.toHaveBeenCalled();
    expect(fixture.voice.speak).not.toHaveBeenCalled();
  });

  it('loops Tab and Shift+Tab at the enabled controls', async () => {
    await renderVoice();
    const first = button('Fermer le mode vocal');
    const last = button('Activer le micro');
    last.focus();
    expect((await press(last, 'Tab')).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect((await press(first, 'Tab', true)).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('keeps a keyboard-scrollable transcript in the loop while the microphone is disabled', async () => {
    fixture.voice.isTranscribing = true;
    await renderVoice();
    const first = button('Fermer le mode vocal');
    const transcript = document.querySelector<HTMLElement>('[role="region"][aria-label="Transcription et réponse"]');
    expect(transcript?.tabIndex).toBe(0);
    expect(button('Traitement en cours').disabled).toBe(true);
    first.focus();
    expect((await press(first, 'Tab', true)).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(transcript);
    expect((await press(transcript!, 'Tab')).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it.each(['Escape', 'close button'])('closes via %s, cancels the turn and returns focus', async (method) => {
    await renderVoice();
    vi.mocked(fixture.voice.cancelRecording).mockClear();
    vi.mocked(fixture.voice.stopSpeaking).mockClear();
    if (method === 'Escape') await press(button('Fermer le mode vocal'), 'Escape');
    else await act(async () => button('Fermer le mode vocal').click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fixture.voice.cancelRecording).toHaveBeenCalled();
    expect(fixture.voice.stopSpeaking).toHaveBeenCalled();
    await renderVoice();
    await settleClose();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(previousControl);
    expect(previousControl.hasAttribute('aria-hidden')).toBe(false);
  });

  it('Escape aborts an in-flight reply and a late success cannot be spoken', async () => {
    let resolveReply: (value: string) => void = () => {};
    onSend = vi.fn<SendReply>(() => new Promise<string>(resolve => { resolveReply = resolve; }));
    await renderVoice();
    await finishTranscription();
    expect(onSend).toHaveBeenCalledTimes(1);
    const signal = onSend.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    await press(button('Fermer le mode vocal'), 'Escape');
    expect(signal.aborted).toBe(true);
    await renderVoice();
    await act(async () => resolveReply('Une réponse tardive'));
    expect(fixture.voice.speak).not.toHaveBeenCalled();
  });

  it('names the current action and interrupts speech without starting the microphone', async () => {
    await renderVoice();
    expect(button('Activer le micro').disabled).toBe(false);
    fixture.voice = { ...fixture.voice, isRecording: true };
    await renderVoice();
    expect(button("Terminer l'enregistrement").disabled).toBe(false);
    fixture.voice = { ...fixture.voice, isRecording: false, isTranscribing: true };
    await renderVoice();
    expect(button('Traitement en cours').disabled).toBe(true);
    fixture.voice = { ...fixture.voice, isTranscribing: false, isSpeaking: true };
    await renderVoice();
    vi.mocked(fixture.voice.stopSpeaking).mockClear();
    await act(async () => button('Interrompre la réponse').click());
    expect(fixture.voice.stopSpeaking).toHaveBeenCalledTimes(1);
    expect(fixture.voice.startRecording).not.toHaveBeenCalled();
  });

  it('retains the complete answer in a named, keyboard-scrollable region', async () => {
    const reply = Array.from({ length: 80 }, (_, index) => `Paragraphe ${index + 1} : réponse consultable.`).join('\n');
    onSend = vi.fn<SendReply>(async () => reply);
    await renderVoice();
    await finishTranscription();
    const answer = [...document.querySelectorAll('p')].find(node => node.textContent === reply);
    expect(answer).toBeDefined();
    expect(answer?.className).not.toMatch(/line-clamp/);
    expect(answer?.closest('[role="region"]')?.getAttribute('tabindex')).toBe('0');
    expect(fixture.voice.speak).toHaveBeenCalledWith(reply);
  });
});

describe('AgentChatTab: named text controls and reduced motion', () => {
  it.each([
    { name: 'native IME composition', init: { isComposing: true, keyCode: 13, shiftKey: false } },
    { name: 'legacy IME key code 229', init: { isComposing: false, keyCode: 229, shiftKey: false } },
    { name: 'Shift+Enter', init: { isComposing: false, keyCode: 13, shiftKey: true } },
  ])('preserves the draft for $name and still sends on a later plain Enter', async ({ init }) => {
    vi.mocked(sendAgentChatMessage).mockClear();
    await act(async () => root.render(<AgentChatTab agentType="email" agentName="Email IA" agentEmoji="🤖" agentColor="#8B5CF6" />));
    const input = host.querySelector('textarea')!;
    const draft = '日本語で相談したいです';
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, draft);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button('Envoyer le message').disabled).toBe(false);
    input.focus();
    if (!init.shiftKey) {
      await act(async () => { input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
    }
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
    expect(event.isComposing).toBe(init.isComposing);
    expect(event.keyCode).toBe(init.keyCode);
    await act(async () => { input.dispatchEvent(event); });
    expect(sendAgentChatMessage).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(input.value).toBe(draft);
    expect(host.textContent).toContain('Démarre une conversation avec Email IA');
    expect(fixture.voice.startRecording).not.toHaveBeenCalled();
    expect(fixture.voice.speak).not.toHaveBeenCalled();
    if (!init.shiftKey) {
      await act(async () => { input.dispatchEvent(new CompositionEvent('compositionend', { data: draft, bubbles: true })); });
    }
    const submitEvent = await press(input, 'Enter');
    expect(submitEvent.defaultPrevented).toBe(true);
    expect(sendAgentChatMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendAgentChatMessage).mock.calls[0][2]).toBe(draft);
    expect(input.value).toBe('');
  });

  it('names the message field and icon-only send button', async () => {
    await act(async () => root.render(<AgentChatTab agentType="email" agentName="Email IA" agentEmoji="🤖" agentColor="#8B5CF6" />));
    expect(host.querySelector('textarea')?.getAttribute('aria-label')).toBe('Message pour Email IA');
    expect(button('Envoyer le message').disabled).toBe(true);
  });

  it('uses immediate scrolling when reduced motion is requested', async () => {
    fixture.reducedMotion = true;
    await act(async () => root.render(<AgentChatTab agentType="email" agentName="Email IA" agentEmoji="🤖" agentColor="#8B5CF6" />));
    expect(scrollTo).toHaveBeenCalled();
    expect(scrollTo.mock.calls.every(([options]) => options.behavior === 'auto')).toBe(true);
  });
});
