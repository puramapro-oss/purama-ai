import { test, expect, type Page } from '@playwright/test';
import type {} from './transport';

async function count(page: Page, kind: string) {
  return page.evaluate(kind => window.voiceHarness.pending.filter((p) => p.kind === kind).length, kind);
}
async function settle(page: Page) {
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 60)));
}
async function startCapture(page: Page) {
  await page.evaluate(() => { void window.voiceHarness.voice.startRecording(); });
  await expect.poll(() => count(page, 'media')).toBe(1);
  await page.evaluate(() => window.voiceHarness.resolve('media'));
  await expect(page.getByTestId('recording')).toHaveText('true');
}
async function startModeTurn(page: Page, agentView = false) {
  if (agentView) {
    await page.evaluate(() => window.voiceHarness.setAgentView(true));
    await page.getByRole('button', { name: 'Mode vocal', exact: true }).click();
  } else {
    await page.evaluate(() => window.voiceHarness.setModeOpen(true));
  }
  await page.getByRole('button', { name: 'Activer le micro', exact: true }).click();
  await expect.poll(() => count(page, 'media')).toBe(1);
  await page.evaluate(() => window.voiceHarness.resolve('media'));
  await expect(page.getByText('Appuie pour envoyer', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: "Terminer l'enregistrement", exact: true }).click();
  await expect.poll(() => count(page, 'transcribe')).toBe(1);
}

async function openAgentChat(page: Page) {
  await page.evaluate(() => window.voiceHarness.setAgentView(true));
  const input = page.getByRole('textbox', { name: 'Message pour Email IA', exact: true });
  await expect(input).toBeVisible();
  return input;
}

async function startInlineDictation(page: Page) {
  await page.getByRole('button', { name: 'Dicter un message', exact: true }).click();
  await expect.poll(() => count(page, 'media')).toBe(1);
  await page.evaluate(() => window.voiceHarness.resolve('media'));
  await page.getByRole('button', { name: "Arrêter l'enregistrement", exact: true }).click();
  await expect.poll(() => count(page, 'transcribe')).toBe(1);
}

async function prepareAutomaticReply(page: Page, reply: string) {
  const input = page.getByRole('textbox', { name: 'Message pour Email IA', exact: true });
  await input.fill('Question de cette conversation');
  await input.press('Enter');
  await expect.poll(() => count(page, 'backend')).toBe(1);
  await page.evaluate(reply => window.voiceHarness.resolve('backend', {
    data: { reply, tokens: 1 }, error: null,
  }), reply);
  await expect.poll(() => count(page, 'synthesize')).toBe(1);
}

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto('/tests/voice-consent/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.voiceHarness?.voice));
});

test('all session helpers satisfy the real server UUID schema', async ({ page }) => {
  const result = await page.evaluate(() => {
    const h = window.voiceHarness;
    const ids = Array.from({ length: 100 }, () => [h.newAgentSessionId(), h.newLegalSession(), h.newCreatorSession()]).flat();
    return { valid: ids.every(h.validateSession), unique: new Set(ids).size, size: ids.length };
  });
  expect(result).toEqual({ valid: true, unique: 300, size: 300 });
});

test('UUID fallback remains valid when randomUUID is unavailable', async ({ page }) => {
  const result = await page.evaluate(() => {
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    const h = window.voiceHarness;
    return [h.newAgentSessionId(), h.newLegalSession(), h.newCreatorSession()].every(h.validateSession);
  });
  expect(result).toBe(true);
});

test('already revoked requests never invoke a chat backend', async ({ page }) => {
  const errors = await page.evaluate(async () => {
    const h = window.voiceHarness;
    const controller = new AbortController(); controller.abort();
    const id = h.newAgentSessionId();
    const requests = [
      () => h.sendAgentChatMessage('email', id, 'Bonjour', controller.signal),
      () => h.sendChatMessage(id, 'Bonjour', controller.signal),
      () => h.chatWithAgent(id, id, 'Bonjour', controller.signal),
    ];
    return Promise.all(requests.map(request => request().then(() => 'unexpected', (error: Error) => error.name)));
  });
  expect(errors).toEqual(['AbortError', 'AbortError', 'AbortError']);
  expect(await count(page, 'backend')).toBe(0);
});

test('cancelling during token lookup prevents a delayed TTS request', async ({ page }) => {
  await page.evaluate(() => {
    const h = window.voiceHarness;
    h.controller = new AbortController(); h.actualVoiceError = 'pending';
    void h.actualSynthesizeSpeech('Message privé', { provider: 'openai', voice_id: 'nova', speed: 1 }, h.controller.signal)
      .then(() => { h.actualVoiceError = 'unexpected'; }, (error: Error) => { h.actualVoiceError = error.name; });
  });
  await expect.poll(() => count(page, 'auth-session')).toBe(1);
  await page.evaluate(() => {
    const h = window.voiceHarness; h.controller.abort();
    h.resolve('auth-session', { data: { session: { access_token: 'fixture' } } });
  });
  await expect.poll(() => page.evaluate(() => window.voiceHarness.actualVoiceError)).toBe('AbortError');
  expect(await count(page, 'voice-fetch')).toBe(0);
});

test('cancelling audio encoding prevents a delayed transcription request', async ({ page }) => {
  await page.evaluate(() => {
    const h = window.voiceHarness;
    h.controller = new AbortController(); h.actualVoiceError = 'pending';
    const blob = new Blob(['fixture']);
    blob.arrayBuffer = () => h.defer('encoding');
    void h.actualTranscribeAudio(blob, 'fr', h.controller.signal)
      .then(() => { h.actualVoiceError = 'unexpected'; }, (error: Error) => { h.actualVoiceError = error.name; });
  });
  await expect.poll(() => count(page, 'encoding')).toBe(1);
  await page.evaluate(() => {
    const h = window.voiceHarness; h.controller.abort(); h.resolve('encoding', new Uint8Array(16).buffer);
  });
  await expect.poll(() => page.evaluate(() => window.voiceHarness.actualVoiceError)).toBe('AbortError');
  expect(await count(page, 'backend')).toBe(0);
});

test('Stop suppresses a late TTS success and its browser fallback', async ({ page }) => {
  await page.evaluate(() => { void window.voiceHarness.voice.speak('Parole tardive'); });
  await expect.poll(() => count(page, 'synthesize')).toBe(1);
  await page.evaluate(() => {
    const h = window.voiceHarness;
    h.voice.stopSpeaking(); h.resolve('synthesize');
  });
  await settle(page);
  expect(await page.evaluate(() => window.voiceHarness.played.length)).toBe(0);
  expect(await page.evaluate(() => window.voiceHarness.browserSpoken.length)).toBe(0);
  await expect(page.getByTestId('speaking')).toHaveText('false');
});

test('a failed TTS response after Stop cannot start browser speech', async ({ page }) => {
  await page.evaluate(() => { void window.voiceHarness.voice.speak('Ne pas lire'); });
  await expect.poll(() => count(page, 'synthesize')).toBe(1);
  await page.evaluate(() => {
    const h = window.voiceHarness;
    h.voice.stopSpeaking(); h.pending.find((p) => p.kind === 'synthesize').reject(new Error('late failure'));
  });
  await settle(page);
  expect(await page.evaluate(() => window.voiceHarness.browserSpoken.length)).toBe(0);
});

test('only the latest speech request may play', async ({ page }) => {
  await page.evaluate(() => {
    const h = window.voiceHarness;
    void h.voice.speak('Ancienne'); void h.voice.speak('Nouvelle');
  });
  await expect.poll(() => count(page, 'synthesize')).toBe(2);
  await page.evaluate(() => window.voiceHarness.resolve('synthesize', undefined, 0));
  await settle(page);
  expect(await page.evaluate(() => window.voiceHarness.played.length)).toBe(0);
  await page.evaluate(() => window.voiceHarness.resolve('synthesize', undefined, 1));
  await expect.poll(() => page.evaluate(() => window.voiceHarness.played.length)).toBe(1);
});

test('Stop releases the audio URL and stale end events cannot stop newer playback', async ({ page }) => {
  await page.evaluate(() => { void window.voiceHarness.voice.speak('Une'); });
  await page.evaluate(() => window.voiceHarness.resolve('synthesize'));
  await expect.poll(() => page.evaluate(() => window.voiceHarness.played.length)).toBe(1);
  await page.evaluate(() => { void window.voiceHarness.voice.speak('Deux'); });
  await page.evaluate(() => window.voiceHarness.resolve('synthesize', undefined, 1));
  await expect.poll(() => page.evaluate(() => window.voiceHarness.played.length)).toBe(2);
  await page.evaluate(() => window.voiceHarness.audios[0].queuedEnd?.());
  await expect(page.getByTestId('speaking')).toHaveText('true');
  expect(await page.evaluate(() => window.voiceHarness.revoked.length)).toBe(1);
  await page.evaluate(() => window.voiceHarness.voice.stopSpeaking());
  expect(await page.evaluate(() => window.voiceHarness.revoked.length)).toBe(2);
});

test('unmount prevents late speech from playing', async ({ page }) => {
  await page.evaluate(() => { void window.voiceHarness.voice.speak('Confidentiel'); });
  await page.evaluate(() => window.voiceHarness.setMounted(false));
  await expect(page.getByText('Fixture démontée')).toBeVisible();
  await page.evaluate(() => window.voiceHarness.resolve('synthesize'));
  await settle(page);
  expect(await page.evaluate(() => window.voiceHarness.played.length)).toBe(0);
});

test('cancelling a pending microphone permission stops the eventual stream', async ({ page }) => {
  await page.evaluate(() => { void window.voiceHarness.voice.startRecording(); });
  await expect.poll(() => count(page, 'media')).toBe(1);
  await page.evaluate(() => {
    const h = window.voiceHarness; h.voice.cancelRecording(); h.resolve('media');
  });
  await expect.poll(() => page.evaluate(() => window.voiceHarness.stoppedTracks)).toBe(1);
  expect(await page.evaluate(() => window.voiceHarness.recorders.length)).toBe(0);
  expect(await count(page, 'transcribe')).toBe(0);
});

test('cancel resolves a pending recorder-stop promise without sending audio', async ({ page }) => {
  await startCapture(page);
  await page.evaluate(() => {
    const h = window.voiceHarness; h.deferRecorderStop = true;
    h.stopResult = 'pending'; void h.voice.stopRecording().then((result: unknown) => { h.stopResult = result; });
  });
  await page.evaluate(() => window.voiceHarness.voice.cancelRecording());
  await expect.poll(() => page.evaluate(() => window.voiceHarness.stopResult)).toBe(null);
  await page.evaluate(() => window.voiceHarness.stopEvents.forEach((dispatch: () => void) => dispatch()));
  expect(await count(page, 'transcribe')).toBe(0);
});

test('a normal capture still returns the transcript and releases the microphone', async ({ page }) => {
  await startCapture(page);
  await page.evaluate(() => {
    const h = window.voiceHarness;
    void h.voice.stopRecording().then((result: unknown) => { h.stopResult = result; });
  });
  await expect.poll(() => count(page, 'transcribe')).toBe(1);
  await page.evaluate(() => window.voiceHarness.resolve('transcribe', 'Bonjour'));
  await expect.poll(() => page.evaluate(() => window.voiceHarness.stopResult)).toBe('Bonjour');
  await expect(page.getByTestId('transcribing')).toHaveText('false');
  expect(await page.evaluate(() => window.voiceHarness.stoppedTracks)).toBe(1);
});

test('closing the mode during transcription prevents the chat call', async ({ page }) => {
  await startModeTurn(page);
  await page.getByRole('button', { name: 'Fermer le mode vocal' }).click();
  await page.evaluate(() => window.voiceHarness.resolve('transcribe', 'Texte abandonné'));
  await settle(page);
  expect(await count(page, 'backend')).toBe(0);
  expect(await count(page, 'synthesize')).toBe(0);
});

test('closing an actual agent chat aborts its reply and prevents autoplay after a late success', async ({ page }) => {
  await startModeTurn(page, true);
  await page.evaluate(() => window.voiceHarness.resolve('transcribe', 'Question confidentielle'));
  await expect.poll(() => count(page, 'backend')).toBe(1);
  expect(await page.evaluate(() => {
    const h = window.voiceHarness;
    return h.validateSession(String(h.pending.find((p) => p.kind === 'backend').args.body.session_id));
  })).toBe(true);
  await page.getByRole('button', { name: 'Fermer le mode vocal' }).click();
  expect(await page.evaluate(() => window.voiceHarness.pending.find((p) => p.kind === 'backend').args.signal.aborted)).toBe(true);
  await page.evaluate(() => window.voiceHarness.resolve('backend', { data: { reply: 'Réponse annulée', tokens: 1 }, error: null }));
  await settle(page);
  expect(await count(page, 'synthesize')).toBe(0);
  await expect(page.getByText('Réponse annulée')).toHaveCount(0);
});

test('account change invalidates a voice reply before it can be spoken', async ({ page }) => {
  await startModeTurn(page);
  await page.evaluate(() => window.voiceHarness.resolve('transcribe', 'Texte privé'));
  await expect.poll(() => count(page, 'backend')).toBe(1);
  await page.evaluate(() => window.voiceHarness.setIdentity('00000000-0000-4000-8000-000000000002'));
  await settle(page);
  await page.evaluate(() => window.voiceHarness.resolve('backend', { data: { reply: 'Ancien compte' } }));
  await settle(page);
  expect(await count(page, 'synthesize')).toBe(0);
  await expect(page.getByText('Ancien compte')).toHaveCount(0);
});

test('normal voice turn returns to idle after playback ends', async ({ page }) => {
  await startModeTurn(page);
  await page.evaluate(() => window.voiceHarness.resolve('transcribe', 'Bonjour'));
  await expect.poll(() => count(page, 'backend')).toBe(1);
  await page.evaluate(() => window.voiceHarness.resolve('backend', { data: { reply: 'Bonjour aussi' } }));
  await expect.poll(() => count(page, 'synthesize')).toBe(1);
  await page.evaluate(() => window.voiceHarness.resolve('synthesize'));
  await expect.poll(() => page.evaluate(() => window.voiceHarness.played.length)).toBe(1);
  await page.evaluate(() => window.voiceHarness.audios[0].queuedEnd?.());
  await expect(page.getByText('Appuie pour parler', { exact: true })).toBeVisible();
});

test('conversation scope: New conversation refuses an old inline dictation result', async ({ page }) => {
  const input = await openAgentChat(page);
  await startInlineDictation(page);
  await page.getByRole('button', { name: 'Nouvelle', exact: true }).click();
  await expect(input).toHaveValue('');
  await page.evaluate(() => window.voiceHarness.resolve('transcribe', 'DICTEE_ANCIENNE_CONVERSATION'));
  await settle(page);
  await expect(input).toHaveValue('');
  expect(await count(page, 'backend')).toBe(0);
  expect(await count(page, 'synthesize')).toBe(0);
});

test('conversation scope: New conversation refuses old automatic speech', async ({ page }) => {
  await openAgentChat(page);
  await prepareAutomaticReply(page, 'REPONSE_ANCIENNE_CONVERSATION');
  await page.getByRole('button', { name: 'Nouvelle', exact: true }).click();
  await expect(page.getByText('REPONSE_ANCIENNE_CONVERSATION', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.voiceHarness.played.length)).toBe(0);
  await page.evaluate(() => window.voiceHarness.resolve('synthesize'));
  await settle(page);
  expect(await page.evaluate(() => window.voiceHarness.played.length)).toBe(0);
  expect(await page.evaluate(() => window.voiceHarness.browserSpoken)).toEqual([]);
});

test('conversation scope: current dictation preserves edits made while transcription is pending', async ({ page }) => {
  const input = await openAgentChat(page);
  await startInlineDictation(page);
  await input.fill('BROUILLON_COURANT');
  await expect(input).toHaveValue('BROUILLON_COURANT');
  await page.evaluate(() => window.voiceHarness.resolve('transcribe', 'DICTEE_COURANTE'));
  await expect(input).toHaveValue('BROUILLON_COURANT DICTEE_COURANTE');
  expect(await page.evaluate(() => window.voiceHarness.stoppedTracks)).toBe(1);
  expect(await count(page, 'backend')).toBe(0);
});

test('conversation scope: current automatic speech and draft survive ordinary rerenders', async ({ page }) => {
  const input = await openAgentChat(page);
  await prepareAutomaticReply(page, 'REPONSE_COURANTE');
  await input.fill('BROUILLON_A_CONSERVER');
  await expect(input).toHaveValue('BROUILLON_A_CONSERVER');
  await page.evaluate(() => window.voiceHarness.resolve('synthesize'));
  await expect.poll(() => page.evaluate(() => window.voiceHarness.played.length)).toBe(1);
  await expect(input).toHaveValue('BROUILLON_A_CONSERVER');
  await expect(page.getByText('REPONSE_COURANTE', { exact: true })).toBeVisible();
  expect(await count(page, 'synthesize')).toBe(1);
});
