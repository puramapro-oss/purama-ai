import { expect, test, type Page } from '@playwright/test';
const project = { id: 'restaurant', name: 'Maison Solène · Restaurant', ready: true, maxParallel: 3 };
function mission(state = 'active') {
  const done = state === 'verified_done';
  return {
    id: '00000000-0000-4000-8000-000000000010', projectId: 'restaurant',
    title: 'Créer le site du restaurant avec menu et réservations', state,
    createdAt: '2026-11-12T20:00:00Z', updatedAt: '2026-11-12T20:03:00Z', finishedAt: done ? '2026-11-12T20:03:00Z' : null,
    verifiedTasks: done ? 3 : 1, totalTasks: 3, usage: { tokens: 3210, costMicros: 1000 },
    tasks: [
      { id: '00000000-0000-4000-8000-000000000011', key: 'plan', title: 'Architecture et parcours de réservation', state: 'verified_done', provider: 'codex', attempt: 1, outputSha: 'a'.repeat(40), evidenceCount: 2 },
      { id: '00000000-0000-4000-8000-000000000012', key: 'build', title: 'Site responsive, menu et formulaire', state: done ? 'verified_done' : 'running', provider: 'codex', attempt: 1, outputSha: done ? 'b'.repeat(40) : null, evidenceCount: done ? 3 : 0 },
      { id: '00000000-0000-4000-8000-000000000013', key: 'review', title: 'Tests des réservations et revue indépendante', state: done ? 'verified_done' : 'pending', provider: null, attempt: done ? 1 : 0, outputSha: done ? 'b'.repeat(40) : null, evidenceCount: done ? 2 : 0 },
    ],
    ...(done ? { previewUrl: 'https://preview.example.invalid/restaurant' } : {}),
  };
}
async function fixture(page: Page, initial: string | null) {
  let current = initial;
  const calls: Record<string, unknown>[] = [];
  await page.route('**/__workshop-fixture', async route => {
    const body = route.request().postDataJSON();
    calls.push(body);
    const result = body.action === 'list'
      ? { ok: true, projects: [project], missions: current ? [mission(current)] : [] }
      : { ok: true, mission: mission(body.action === 'cancel' ? (current = 'cancelling') : body.action === 'start' ? (current = 'active') : current ?? 'active') };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
  });
  return { calls, setState: (state: string) => { current = state; } };
}
test('desktop: start, true status progression, verification and resume after reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const control = await fixture(page, null);
  await page.goto('/tests/workshop-state/index.html');
  await page.getByLabel('Que voulez-vous créer ou améliorer ?').fill('Créer le site du restaurant avec menu, horaires et réservations sur mobile.');
  await page.getByRole('button', { name: 'Lancer la création' }).click();
  await expect(page.getByText('Agents au travail', { exact: true })).toBeVisible();
  await expect(page.getByTestId('workshop-result')).toHaveCount(0);
  expect(control.calls.filter(call => call.action === 'start')).toHaveLength(1);
  await page.screenshot({ path: 'qa/workshop-20261112/workshop-desktop.png', fullPage: true });
  control.setState('verified_done');
  await expect(page.getByTestId('workshop-result')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ouvrir l’aperçu' })).toHaveAttribute('href', 'https://preview.example.invalid/restaurant');
  await page.reload();
  await expect(page.getByTestId('workshop-result')).toBeVisible();
  expect(control.calls.filter(call => call.action === 'start')).toHaveLength(1);
  expect(errors).toEqual([]);
});
test('mobile: fully accessible controls and no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, 'verified_done');
  await page.goto('/tests/workshop-state/index.html');
  await expect(page.getByTestId('workshop-result')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByLabel('Projet', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'qa/workshop-20261112/workshop-mobile.png', fullPage: true });
});
test('an unavailable backend never produces a false result', async ({ page }) => {
  await page.route('**/__workshop-fixture', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }));
  await page.goto('/tests/workshop-state/index.html');
  await expect(page.getByRole('alert')).toContainText('Les agents ne sont pas disponibles');
  await expect(page.getByRole('button', { name: 'Lancer la création' })).toBeDisabled();
  await expect(page.getByTestId('workshop-result')).toHaveCount(0);
});
