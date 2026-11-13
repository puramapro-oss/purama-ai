import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
      { id: '00000000-0000-4000-8000-000000000012', key: 'implementation', title: 'Site responsive, menu et formulaire', state: done ? 'verified_done' : 'running', provider: 'codex', attempt: 1, outputSha: done ? 'b'.repeat(40) : null, evidenceCount: done ? 3 : 0 },
      { id: '00000000-0000-4000-8000-000000000013', key: 'review', title: 'Tests des réservations et revue indépendante', state: done ? 'verified_done' : 'pending', provider: null, attempt: done ? 1 : 0, outputSha: done ? 'b'.repeat(40) : null, evidenceCount: done ? 2 : 0 },
    ],
    ...(done ? { previewUrl: 'https://preview.example.invalid/restaurant' } : {}),
  };
}
const archive = Buffer.from([80, 75, 5, 6, ...Array(18).fill(0)]);
const previewHtml = `<!doctype html><html lang="fr"><head><title>Création de test</title></head><body>
<h1 id="generated-title">Ma création interactive</h1><button id="increment">Ajouter</button><output id="counter">0</output><p id="isolation"></p><p id="network"></p>
<script>document.getElementById('increment').onclick=()=>document.getElementById('counter').textContent=String(Number(document.getElementById('counter').textContent)+1);
try{parent.document.body.dataset.previewEscape='unsafe';document.getElementById('isolation').textContent='accessible';}catch{document.getElementById('isolation').textContent='isolé';}
fetch('https://blocked.example/probe').then(()=>document.getElementById('network').textContent='accessible').catch(()=>document.getElementById('network').textContent='bloqué');
</script></body></html>`;
function artifact() {
  return { missionId: mission().id, commitSha: 'b'.repeat(40),
    archive: { fileName: 'restaurant.zip', mediaType: 'application/zip', base64: archive.toString('base64'), bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex') },
    preview: { fileName: 'index.html', mediaType: 'text/html', content: previewHtml, bytes: Buffer.byteLength(previewHtml), sha256: createHash('sha256').update(previewHtml).digest('hex') },
  };
}
async function fixture(page: Page, initial: string | null) {
  let current = initial;
  const calls: Record<string, unknown>[] = [];
  await page.route('**/__workshop-fixture', async route => {
    const body = route.request().postDataJSON();
    calls.push(body);
    const result = body.action === 'artifact' ? { ok: true, artifact: artifact() } : body.action === 'list'
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
  await page.screenshot({ path: 'qa/workshop-20261113/workshop-desktop.png', fullPage: true });
  control.setState('verified_done');
  await expect(page.getByTestId('workshop-result')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accéder aux fichiers' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ouvrir l’aperçu' })).toHaveCount(0);
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
  await page.screenshot({ path: 'qa/workshop-20261113/workshop-mobile.png', fullPage: true });
});
test('an unavailable backend never produces a false result', async ({ page }) => {
  await page.route('**/__workshop-fixture', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }));
  await page.goto('/tests/workshop-state/index.html');
  await expect(page.getByRole('alert')).toContainText('Les agents ne sont pas disponibles');
  await expect(page.getByRole('button', { name: 'Lancer la création' })).toBeDisabled();
  await expect(page.getByTestId('workshop-result')).toHaveCount(0);
});
test('verified artifact: opaque interactive preview, blocked fetch and byte-identical source download', async ({ page }, testInfo) => {
  let networkRequests = 0;
  await page.route('https://blocked.example/**', route => { networkRequests++; return route.abort(); });
  await fixture(page, 'verified_done');
  await page.goto('/tests/workshop-state/index.html');
  await page.getByRole('button', { name: 'Accéder aux fichiers' }).click();
  const source = page.getByRole('link', { name: 'Télécharger les sources ZIP' });
  await expect(source).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await source.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('restaurant.zip');
  const downloadPath = testInfo.outputPath('restaurant.zip');
  await download.saveAs(downloadPath);
  expect(await readFile(downloadPath)).toEqual(archive);
  await page.getByRole('button', { name: 'Afficher l’aperçu' }).click();
  const frame = page.frameLocator('iframe[title="Aperçu isolé de votre création"]');
  await expect(frame.getByText('Ma création interactive', { exact: true })).toBeVisible();
  await expect(frame.locator('#isolation')).toHaveText('isolé');
  await expect(frame.locator('#network')).toHaveText('bloqué');
  await frame.getByRole('button', { name: 'Ajouter' }).click();
  await frame.getByRole('button', { name: 'Ajouter' }).press('Enter');
  await expect(frame.locator('#counter')).toHaveText('2');
  expect(await page.evaluate(() => document.body.dataset.previewEscape)).toBeUndefined();
  expect(await page.locator('#generated-title').count()).toBe(0);
  expect(networkRequests).toBe(0);
  await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  await page.getByRole('button', { name: 'Mobile', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'qa/workshop-20261113/workshop-artifact-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Fermer l’aperçu' }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
});
test('a mismatched artifact never exposes its content or download', async ({ page }) => {
  await fixture(page, 'verified_done');
  await page.route('**/__workshop-fixture', async (route) => {
    if (route.request().postDataJSON().action !== 'artifact') return route.fallback();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, artifact: { ...artifact(), commitSha: 'c'.repeat(40) } }) });
  });
  await page.goto('/tests/workshop-state/index.html');
  await page.getByRole('button', { name: 'Accéder aux fichiers' }).click();
  await expect(page.getByRole('alert')).toContainText('invalide');
  await expect(page.getByRole('link', { name: 'Télécharger les sources ZIP' })).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
});
