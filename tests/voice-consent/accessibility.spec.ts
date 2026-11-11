import { test, expect, type Locator, type Page } from '@playwright/test';
import type {} from './transport';

async function pendingCount(page: Page, kind: string) {
  return page.evaluate(kind => window.voiceHarness.pending.filter(item => item.kind === kind).length, kind);
}

async function openFromKeyboard(page: Page) {
  await page.evaluate(() => {
    window.voiceHarness.autoPlay = false;
    window.voiceHarness.setAgentView(true);
  });
  const trigger = page.getByRole('button', { name: 'Mode vocal', exact: true });
  await trigger.focus();
  await trigger.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Mode vocal avec Email IA', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog.getByRole('button', { name: 'Fermer le mode vocal' })).toBeFocused();
  return { trigger, dialog };
}

async function expectPinnedControls(page: Page, dialog: Locator, state: string) {
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    rootFontSize: getComputedStyle(document.documentElement).fontSize,
  }));
  const controls = [
    { name: 'close', locator: dialog.getByRole('button', { name: 'Fermer le mode vocal', exact: true }) },
    { name: 'primary', locator: dialog.getByRole('button', { name: /^(Activer le micro|Terminer l'enregistrement|Traitement en cours|Interrompre la réponse)$/ }) },
  ];
  const rectangles = [];
  for (const control of controls) {
    const rectangle = await control.locator.boundingBox();
    expect(rectangle, `${state}: ${control.name} has a rendered rectangle`).not.toBeNull();
    if (!rectangle) throw new Error(`Missing ${control.name} rectangle at ${state}`);
    expect(rectangle.x, `${state}: ${control.name} left edge`).toBeGreaterThanOrEqual(0);
    expect(rectangle.y, `${state}: ${control.name} top edge`).toBeGreaterThanOrEqual(0);
    expect(rectangle.x + rectangle.width, `${state}: ${control.name} right edge`).toBeLessThanOrEqual(viewport.width);
    expect(rectangle.y + rectangle.height, `${state}: ${control.name} bottom edge`).toBeLessThanOrEqual(viewport.height);
    expect(rectangle.width, `${state}: ${control.name} target width`).toBeGreaterThanOrEqual(44);
    expect(rectangle.height, `${state}: ${control.name} target height`).toBeGreaterThanOrEqual(44);
    rectangles.push({ name: control.name, ...rectangle });
  }
  const readingRegion = await dialog.getByRole('region', { name: 'Transcription et réponse' }).boundingBox();
  expect(readingRegion, `${state}: reading region has a rendered rectangle`).not.toBeNull();
  if (!readingRegion) throw new Error(`Missing reading region rectangle at ${state}`);
  expect(readingRegion.height, `${state}: useful reading region height`).toBeGreaterThanOrEqual(128);
  expect(readingRegion.y, `${state}: reading region top edge`).toBeGreaterThanOrEqual(0);
  expect(readingRegion.y + readingRegion.height, `${state}: reading region bottom edge`).toBeLessThanOrEqual(viewport.height);
  return { state, viewport, controls: rectangles, readingRegion };
}

test.beforeEach(async ({ page }) => {
  // The existing fixture installs fake mediaDevices, MediaRecorder and Audio
  // before React mounts. No microphone permission or real speech service is used.
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.abort());
  await page.goto('/tests/voice-consent/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.voiceHarness?.voice));
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || page.isClosed()) return;
  const path = testInfo.outputPath('voice-accessibility-failure.png');
  await page.screenshot({ path, timeout: 5_000 });
  await testInfo.attach('voice-accessibility-failure', { path, contentType: 'image/png' });
});

test('keyboard modal lifecycle restores its real trigger without requesting a microphone', async ({ page }, testInfo) => {
  const { trigger, dialog } = await openFromKeyboard(page);
  const close = dialog.getByRole('button', { name: 'Fermer le mode vocal' });
  const transcript = dialog.getByRole('region', { name: 'Transcription et réponse' });
  const mic = dialog.getByRole('button', { name: 'Activer le micro', exact: true });
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.keyboard.press('Tab');
    await expect(transcript).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(mic).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(mic).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(transcript).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(close).toBeFocused();
  }
  const screenshot = testInfo.outputPath('voice-modal-keyboard-desktop.png');
  await page.screenshot({ path: screenshot });
  await testInfo.attach('voice-modal-keyboard', { path: screenshot, contentType: 'image/png' });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.press('Enter');
  await expect(close).toBeFocused();
  await close.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await pendingCount(page, 'media')).toBe(0);
  expect(await pendingCount(page, 'transcribe')).toBe(0);
  expect(await pendingCount(page, 'backend')).toBe(0);
  expect(await pendingCount(page, 'synthesize')).toBe(0);
});

test('text chat exposes named input and send controls', async ({ page }) => {
  await page.evaluate(() => {
    window.voiceHarness.autoPlay = false;
    window.voiceHarness.setAgentView(true);
  });
  const input = page.getByRole('textbox', { name: 'Message pour Email IA', exact: true });
  const send = page.getByRole('button', { name: 'Envoyer le message', exact: true });
  await expect(send).toBeDisabled();
  await input.fill('Bonjour par écrit');
  await expect(send).toBeEnabled();
  await send.focus();
  await send.press('Enter');
  await expect.poll(() => pendingCount(page, 'backend')).toBe(1);
  expect(await pendingCount(page, 'media')).toBe(0);
  expect(await pendingCount(page, 'synthesize')).toBe(0);
});

for (const layout of [
  { name: 'desktop', viewport: { width: 1280, height: 800 }, textScale: 1 },
  { name: 'narrow-320-text-200-percent', viewport: { width: 320, height: 640 }, textScale: 2 },
  { name: 'short-landscape-640-text-200-percent', viewport: { width: 640, height: 360 }, textScale: 2 },
]) {
  test(`complete long answer is keyboard-scrollable: ${layout.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(layout.viewport);
    await page.evaluate(scale => {
      document.documentElement.style.fontSize = `${parseFloat(getComputedStyle(document.documentElement).fontSize) * scale}px`;
    }, layout.textScale);
    const { trigger, dialog } = await openFromKeyboard(page);
    const geometry = [await expectPinnedControls(page, dialog, 'opened')];
    const mic = dialog.getByRole('button', { name: 'Activer le micro', exact: true });
    await mic.click();
    await expect.poll(() => pendingCount(page, 'media')).toBe(1);
    // Resolve the fixture's synthetic stream; this never grants hardware access.
    await page.evaluate(() => window.voiceHarness.resolve('media'));
    await expect(dialog.getByText('Appuie pour envoyer', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: "Terminer l'enregistrement", exact: true }).click();
    await expect.poll(() => pendingCount(page, 'transcribe')).toBe(1);
    await expect(dialog.getByRole('button', { name: 'Traitement en cours', exact: true })).toBeDisabled();
    geometry.push(await expectPinnedControls(page, dialog, 'processing'));
    await page.evaluate(() => window.voiceHarness.resolve('transcribe', 'Une question écrite par le double de test'));
    await expect.poll(() => pendingCount(page, 'backend')).toBe(1);
    const reply = Array.from({ length: 80 }, (_, index) => `Paragraphe ${index + 1} : une réponse entièrement consultable.`)
      .concat('référence'.repeat(120), 'FIN DE LA RÉPONSE COMPLÈTE').join('\n');
    await page.evaluate(reply => window.voiceHarness.resolve('backend', { data: { reply, tokens: 1 }, error: null }), reply);
    const transcript = dialog.getByRole('region', { name: 'Transcription et réponse' });
    await expect(transcript.getByText(reply, { exact: true })).toBeVisible();
    expect(await transcript.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await transcript.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await transcript.focus();
    await page.keyboard.press('Control+End');
    await expect.poll(() => transcript.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 2)).toBe(true);
    geometry.push(await expectPinnedControls(page, dialog, 'long-answer-end'));
    expect(await transcript.evaluate(element => {
      const paragraph = [...element.querySelectorAll('p')].find(node => node.textContent?.endsWith('FIN DE LA RÉPONSE COMPLÈTE'));
      const text = paragraph?.firstChild;
      if (!text?.textContent) return false;
      const range = document.createRange();
      range.setStart(text, text.textContent.lastIndexOf('FIN DE LA RÉPONSE COMPLÈTE'));
      range.setEnd(text, text.textContent.length);
      const lastLine = range.getBoundingClientRect();
      const region = element.getBoundingClientRect();
      return lastLine.top >= region.top && lastLine.bottom <= region.bottom + 1;
    })).toBe(true);
    const screenshot = testInfo.outputPath(`voice-long-answer-${layout.name}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach(`voice-long-answer-${layout.name}`, { path: screenshot, contentType: 'image/png' });
    await testInfo.attach(`voice-geometry-${layout.name}`, { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    // A pending synthesis is cancelled by the same existing closeMode path.
    await expect.poll(() => pendingCount(page, 'synthesize')).toBe(1);
    await page.evaluate(() => window.voiceHarness.resolve('synthesize'));
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 60)));
    expect(await page.evaluate(() => window.voiceHarness.played.length)).toBe(0);
    expect(await page.evaluate(() => window.voiceHarness.browserSpoken.length)).toBe(0);
  });
}

test('reduced motion keeps the active microphone and waveform still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.voiceHarness?.voice));
  const { dialog } = await openFromKeyboard(page);
  const mic = dialog.getByRole('button', { name: 'Activer le micro', exact: true });
  await mic.click();
  await expect.poll(() => pendingCount(page, 'media')).toBe(1);
  await page.evaluate(() => window.voiceHarness.resolve('media'));
  await expect(dialog.getByText('Appuie pour envoyer', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: "Terminer l'enregistrement", exact: true })).toHaveCSS('animation-name', 'none');
  const bars = dialog.getByRole('region', { name: 'Transcription et réponse' }).locator('[aria-hidden="true"] span');
  await expect(bars).toHaveCount(32);
  await expect.poll(() => bars.evaluateAll(elements => elements.every(element => parseFloat(getComputedStyle(element).height) === 8))).toBe(true);
  await page.keyboard.press('Escape');
  expect(await pendingCount(page, 'transcribe')).toBe(0);
  expect(await page.evaluate(() => window.voiceHarness.stoppedTracks)).toBe(1);
});
