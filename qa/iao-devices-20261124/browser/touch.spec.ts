import { test, expect } from '../../../tests/chat/fixtures';
import type { Plan } from '../../../tests/chat/transport';

test('touch controls preserve a draft through viewport rotation and stop the same response', async ({ page, browser, browserName, viewport }, testInfo) => {
  expect(viewport).not.toBeNull();
  await page.goto('/tests/chat/index.html');
  await page.getByRole('button', { name: "Ouvrir l'assistant PURA" }).tap();
  const dialog = page.getByRole('dialog');
  const input = page.getByRole('textbox', { name: 'Votre message' });
  await expect(dialog).toContainText('Décrivez ce que vous souhaitez faire.');
  await expect(dialog).toBeInViewport({ ratio: 1 });
  const prompt = 'Conserver mon projet pendant la rotation. 🧭';
  await input.fill(prompt);

  const landscape = { width: viewport!.height, height: viewport!.width };
  await page.setViewportSize(landscape);
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expect(input).toBeInViewport({ ratio: 1 });
  await expect(input).toHaveValue(prompt);
  // Scrolling auxiliary content must keep the header and composer usable.
  for (const name of [
    'Quels sont vos tarifs ?',
    'Comment fonctionnent les agents ?',
    "Programme d'affiliation",
    'Comment connecter Gmail ?',
  ]) {
    const suggestion = dialog.getByRole('button', { name, exact: true });
    await suggestion.scrollIntoViewIfNeeded();
    try {
      await expect(suggestion).toBeInViewport({ ratio: 1 });
    } catch (error) {
      // Read geometry only after the unchanged assertion fails, so diagnostics
      // cannot affect the scrolling or layout of a passing assertion.
      let observation: unknown;
      try {
        observation = await suggestion.evaluate(element => {
          const ancestors = [];
          for (let node: Element | null = element; node && ancestors.length < 7; node = node.parentElement) {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            ancestors.push({
              tag: node.tagName,
              cssClass: node.getAttribute('class'),
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
              clientWidth: node.clientWidth, clientHeight: node.clientHeight,
              scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight,
              scrollTop: node.scrollTop, scrollLeft: node.scrollLeft,
              overflowX: style.overflowX, overflowY: style.overflowY,
              scrollMarginTop: style.scrollMarginTop, scrollMarginBottom: style.scrollMarginBottom,
            });
          }
          return { innerWidth, innerHeight, devicePixelRatio, ancestors };
        });
      } catch (observationError) {
        observation = { error: observationError instanceof Error ? observationError.message : String(observationError) };
      }
      await testInfo.attach('suggestion-scroll-failure.json', {
        body: Buffer.from(JSON.stringify({ suggestion: name, observation }, null, 2)),
        contentType: 'application/json',
      });
      throw error;
    }
    await expect(page.getByRole('button', { name: "Fermer l'assistant" })).toBeInViewport({ ratio: 1 });
    await expect(input).toBeInViewport({ ratio: 1 });
  }
  const responsePlan: Plan = { stream: true, text: 'Fragment tactile provisoire' };
  await page.evaluate(plan => { window.__chatHarness.plans.chatbot = [plan]; }, responsePlan);
  await page.getByRole('button', { name: 'Envoyer le message' }).tap();
  await expect(dialog).toContainText(responsePlan.text!);
  const stop = page.getByRole('button', { name: 'Arrêter la réponse' });
  await expect(stop).toBeInViewport({ ratio: 1 });
  await stop.tap();
  await expect(dialog).not.toContainText(responsePlan.text!);
  await expect(input).toHaveValue(prompt);
  const calls = await page.evaluate(() => window.__chatHarness.calls.filter(call => call.key === 'chatbot'));
  expect(calls).toHaveLength(1);
  expect(calls[0].aborted).toBe(true);

  await page.setViewportSize(viewport!);
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expect(input).toHaveValue(prompt);
  await testInfo.attach('emulated-touch-environment.json', {
    body: Buffer.from(JSON.stringify({
      scope: 'Linux browser and emulated touch/viewport; no physical device or native virtual keyboard',
      browserName,
      browserVersion: browser.version(),
      project: testInfo.project.name,
      portrait: viewport,
      landscape,
      navigator: await page.evaluate(() => ({
        userAgent: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints,
        innerWidth,
        innerHeight,
        coarsePointer: matchMedia('(pointer: coarse)').matches,
      })),
    }, null, 2)),
    contentType: 'application/json',
  });
  await page.getByRole('button', { name: "Fermer l'assistant" }).tap();
  await expect(dialog).toBeHidden();
});
