import { expect, test } from '@playwright/test';

const A = '00000000-0000-4000-8000-000000000001';
const SA = '10000000-0000-4000-8000-000000000001';
const SB = '10000000-0000-4000-8000-000000000002';

test('legal: a late submitted answer from A cannot enter selected conversation B', async ({ page }, testInfo) => {
  const origin = new URL(String(testInfo.project.use.baseURL)).origin;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort('blockedbyclient'));
  await page.routeWebSocket('**/*', socket => socket.close());
  await page.goto('/tests/ui-state/index.html?page=legal');

  await page.getByRole('button', { name: 'Conversation A', exact: true }).click();
  await expect.poll(() => page.evaluate(session => window.uiStateHarness.pending
    .filter(p => !p.done && p.sessionId === session).length, SA)).toBe(1);
  await page.evaluate(({ session, owner }) => window.uiStateHarness.resolveHistory(session, owner, 'HISTORY-A'), { session: SA, owner: A });
  await expect(page.getByText('HISTORY-A', { exact: true })).toBeVisible();
  const input = page.getByPlaceholder('Pose ta question juridique…');
  await input.fill('QUESTION-A');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(session => window.uiStateHarness.replies
    .filter(p => !p.done && p.sessionId === session && p.message === 'QUESTION-A').length, SA)).toBe(1);
  await expect(input).toBeDisabled();

  await page.getByRole('button', { name: 'Conversation B', exact: true }).click();
  await expect.poll(() => page.evaluate(session => window.uiStateHarness.pending
    .filter(p => !p.done && p.sessionId === session).length, SB)).toBe(1);
  await page.evaluate(({ session, owner }) => window.uiStateHarness.resolveHistory(session, owner, 'HISTORY-B'), { session: SB, owner: A });
  await expect(page.getByText('HISTORY-B', { exact: true })).toBeVisible();

  await page.evaluate(session => window.uiStateHarness.resolveReply(session, 'LATE-ANSWER-A'), SA);
  // Wait for the released promise and React's next paint, so an absence assertion cannot win a race.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText('LATE-ANSWER-A', { exact: true })).toHaveCount(0);
  await expect(page.getByText('HISTORY-B', { exact: true })).toBeVisible();
  await expect(input).toBeEnabled();

  await input.fill('QUESTION-B');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(session => window.uiStateHarness.replies
    .filter(p => !p.done && p.sessionId === session && p.message === 'QUESTION-B').length, SB)).toBe(1);
  await page.evaluate(session => window.uiStateHarness.resolveReply(session, 'CURRENT-ANSWER-B'), SB);
  await expect(page.getByText('CURRENT-ANSWER-B', { exact: true })).toBeVisible();
  await expect(page.getByText('HISTORY-B', { exact: true })).toBeVisible();
  await expect(input).toBeEnabled();

  // The old promise must also leave a newer send's pending state intact.
  await input.fill('QUESTION-B-PENDING');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(session => window.uiStateHarness.replies
    .filter(p => !p.done && p.sessionId === session).length, SB)).toBe(1);
  await page.getByRole('button', { name: 'Nouvelle', exact: true }).click();
  await expect(input).toBeEnabled();
  await input.fill('QUESTION-NEW');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.uiStateHarness.replies
    .filter(p => !p.done && p.message === 'QUESTION-NEW').length)).toBe(1);
  const newSession = await page.evaluate(() => window.uiStateHarness.replies
    .find(p => !p.done && p.message === 'QUESTION-NEW')!.sessionId);
  await page.evaluate(session => window.uiStateHarness.resolveReply(session, 'LATE-ANSWER-B'), SB);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText('LATE-ANSWER-B', { exact: true })).toHaveCount(0);
  await expect(page.getByText('QUESTION-NEW', { exact: true })).toBeVisible();
  await expect(input).toBeDisabled();
  await page.evaluate(session => window.uiStateHarness.resolveReply(session, 'CURRENT-ANSWER-NEW'), newSession);
  await expect(page.getByText('CURRENT-ANSWER-NEW', { exact: true })).toBeVisible();
  await expect(input).toBeEnabled();
});
