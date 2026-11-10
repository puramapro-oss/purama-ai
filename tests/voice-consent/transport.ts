import type { UseVoice } from '../../src/hooks/useVoice';

type Deferred = {
  kind: string;
  args: Record<string, unknown> & { body?: Record<string, unknown>; signal?: AbortSignal };
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

export const harness = {
  pending: [] as Deferred[],
  played: [] as string[],
  audios: [] as FakeAudio[],
  revoked: [] as string[],
  browserSpoken: [] as string[],
  browserSpeaking: false,
  stoppedTracks: 0,
  recorders: [] as FakeMediaRecorder[],
  stopEvents: [] as (() => void)[],
  deferRecorderStop: false,
  autoPlay: true,
  voice: null as unknown,
  stopResult: 'unrequested' as unknown,
  setIdentity: (_id: string | null) => {},
  setMounted: (_mounted: boolean) => {},
  setAgentView: (_enabled: boolean) => {},
  setModeOpen: (_open: boolean) => {},
  defer(kind: string, args: Record<string, unknown> = {}) {
    return new Promise<unknown>((resolve, reject) => {
      harness.pending.push({ kind, args, resolve, reject });
    });
  },
  resolve(kind: string, value?: unknown, index = 0) {
    const item = harness.pending.filter(p => p.kind === kind)[index];
    if (!item) throw new Error(`Missing deferred ${kind}:${index}`);
    if (kind === 'media') item.resolve({ getTracks: () => [{ stop: () => harness.stoppedTracks++ }] });
    else if (kind === 'synthesize') item.resolve(value === null ? null : new Blob(['fixture audio']));
    else item.resolve(value);
  },
};

class FakeAudio {
  src: string;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  queuedEnd: (() => void) | null = null;
  paused = false;
  constructor(src: string) { this.src = src; harness.audios.push(this); }
  async play() { this.queuedEnd = this.onended; harness.played.push(this.src); }
  pause() { this.paused = true; }
}

class FakeMediaRecorder {
  static isTypeSupported() { return true; }
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { harness.recorders.push(this); }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    const dispatch = () => {
      this.ondataavailable?.({ data: new Blob(['a'.repeat(400)]) });
      this.onstop?.();
    };
    if (harness.deferRecorderStop) harness.stopEvents.push(dispatch);
    else queueMicrotask(dispatch);
  }
}

class FakeAudioContext {
  createMediaStreamSource() { return { connect() {} }; }
  createAnalyser() {
    return { fftSize: 256, frequencyBinCount: 128, getByteFrequencyData(array: Uint8Array) { array.fill(0); }, disconnect() {} };
  }
  async close() {}
}

Object.defineProperty(window, 'Audio', { value: FakeAudio });
Object.defineProperty(window, 'MediaRecorder', { value: FakeMediaRecorder });
Object.defineProperty(window, 'AudioContext', { value: FakeAudioContext });
Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
  getUserMedia: () => harness.defer('media'),
} });
Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
  get speaking() { return harness.browserSpeaking; },
} });
const revoke = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = url => { harness.revoked.push(url); revoke(url); };
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => String(input).includes('/functions/v1/voice-tts')
  ? harness.defer('voice-fetch', { input, ...init }) as Promise<Response>
  : realFetch(input, init);

const query = {
  select() { return this; }, eq() { return this; }, order() { return this; }, limit() { return this; },
  then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: [], error: null }).then(resolve); },
};
export const supabase = {
  from: () => query,
  auth: { getSession: () => harness.defer('auth-session') },
  functions: {
    // Intentionally ignore abort here: the client must reject even a late transport success.
    invoke: (endpoint: string, options: { body: Record<string, unknown>; signal?: AbortSignal }) =>
      harness.defer('backend', { endpoint, ...options }),
  },
};

export type VoiceHarness = Omit<typeof harness, 'voice'> & {
  voice: UseVoice;
  newAgentSessionId: typeof import('../../src/lib/agent-chat').newAgentSessionId;
  newLegalSession: typeof import('../../src/lib/legal').newSessionId;
  newCreatorSession: typeof import('../../src/lib/creator-agent').newSessionId;
  sendAgentChatMessage: typeof import('../../src/lib/agent-chat').sendAgentChatMessage;
  sendChatMessage: typeof import('../../src/lib/legal').sendChatMessage;
  chatWithAgent: typeof import('../../src/lib/creator-agent').chatWithAgent;
  actualSynthesizeSpeech: typeof import('../../src/lib/voice').synthesizeSpeech;
  actualTranscribeAudio: typeof import('../../src/lib/voice').transcribeAudio;
  validateSession: (id: string) => boolean;
  controller: AbortController;
  actualVoiceError: string;
};
declare global { interface Window { voiceHarness: VoiceHarness } }
window.voiceHarness = harness as VoiceHarness;
