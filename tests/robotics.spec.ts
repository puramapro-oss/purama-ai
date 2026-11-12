import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const fakeUser = { id: '00000000-0000-4000-a000-000000000011', email: 'robot-test@example.invalid', aud: 'authenticated', role: 'authenticated' };

async function prepare(page: Page, signedIn = true) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'http://127.0.0.1:4174') return route.continue();
    if (url.origin !== 'https://robotics-test.invalid') return route.abort();
    let body: unknown = [];
    if (url.pathname.includes('/auth/v1/user')) body = fakeUser;
    else if (url.pathname.includes('/profiles')) body = { id: 'profile-test', user_id: fakeUser.id, full_name: 'Test robots' };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.addInitScript(({ user, signedIn }) => {
    localStorage.setItem('purama-lang', 'fr');
    localStorage.setItem('purama_ai_intro_seen', '1');
    localStorage.setItem('cookie_consent', JSON.stringify({ essential: true, analytics: false, timestamp: Date.now() }));
    localStorage.setItem('purama-pwa-banner-dismissed', '1');
    localStorage.setItem('purama_ai_tutorial_completed', 'true');
    sessionStorage.setItem('purama_affirmation_shown', 'true');
    if (!signedIn) return;
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = [btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), btoa(JSON.stringify({ sub: user.id, exp, aud: 'authenticated' })), 'test-signature'].join('.');
    localStorage.setItem('sb-robotics-test-auth-token', JSON.stringify({ access_token: token, refresh_token: 'test-refresh', token_type: 'bearer', expires_at: exp, expires_in: 3600, user }));
  }, { user: fakeUser, signedIn });
}

test('la route exige une session', async ({ page }) => {
  await prepare(page, false);
  await page.goto('/dashboard/robots');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Vos robots, avec PURAMA' })).toHaveCount(0);
});

test('catalogue, accès constructeur et absence de faux raccordement', async ({ page }, testInfo) => {
  await prepare(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/dashboard/robots');
  await expect(page.getByRole('heading', { name: 'Vos robots, avec PURAMA' })).toBeVisible();
  await expect(page.getByLabel('Modèle de robot').locator('option')).toHaveCount(12);
  await expect(page.getByText('Connexion matérielle à préparer', { exact: true })).toBeVisible();
  await expect(page.getByText('Aucun robot connecté', { exact: false })).toBeVisible();
  await page.getByLabel('Modèle de robot').selectOption('pollen-reachy2');
  await expect(page.getByText('SDK Reachy 2 sur le même réseau local', { exact: true })).toBeVisible();
  await page.getByLabel('Modèle de robot').selectOption('unitree-g1-edu');
  await expect(page.getByText("Vérifier l'édition EDU et ses droits de développement.", { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /connecter le robot/i })).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('robot-connection.png'), fullPage: true });
});

test('aperçu complet : édition, pause, reprise, arrêt et fin', async ({ page }, testInfo) => {
  await prepare(page);
  await page.clock.install();
  await page.goto('/dashboard/robots');
  await page.getByRole('button', { name: 'Essayer le simulateur' }).click();
  await page.getByLabel('Texte étape 1', { exact: true }).fill('Bienvenue dans cet aperçu.');
  await page.getByLabel('Durée étape 1 en secondes', { exact: true }).fill('10');
  await page.getByRole('button', { name: 'Supprimer étape 2', exact: true }).click();
  await page.getByLabel('Durée étape 2 en secondes', { exact: true }).fill('1');
  await page.getByRole('button', { name: "Lancer l'aperçu" }).click();
  await expect(page.getByTestId('robot-active-step')).toHaveText('Bienvenue dans cet aperçu.');
  await page.getByRole('button', { name: 'Mettre en pause' }).click();
  await expect(page.getByText('Aperçu en pause', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Nom de la routine')).toBeDisabled();
  await expect(page.getByLabel('Importer une routine PURAMA')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Exporter la routine' })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('robot-rehearsal.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const paused = await page.getByRole('progressbar').getAttribute('value');
  await page.clock.fastForward(1500);
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', paused!);
  await page.getByRole('button', { name: 'Reprendre', exact: true }).click();
  await page.getByRole('button', { name: "Arrêter l'aperçu" }).click();
  await expect(page.getByText('Aperçu arrêté', { exact: true })).toBeVisible();
  await page.getByLabel('Durée étape 1 en secondes', { exact: true }).fill('1');
  await expect(page.getByText('Prêt pour un aperçu', { exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '0');
  await page.getByRole('button', { name: "Lancer l'aperçu" }).click();
  await page.clock.fastForward(2500);
  await expect(page.getByText('Aperçu terminé', { exact: true })).toBeVisible();
});

test('validation du formulaire et remise à zéro lors du changement de modèle', async ({ page }) => {
  await prepare(page);
  await page.goto('/dashboard/robots');
  await page.getByRole('button', { name: 'Essayer le simulateur' }).click();
  await page.getByLabel('Texte étape 1', { exact: true }).fill('   ');
  await page.getByRole('button', { name: "Lancer l'aperçu" }).click();
  await expect(page.getByRole('alert')).toContainText('ajoutez un texte');
  await page.getByLabel('Texte étape 1', { exact: true }).fill('Séance locale');
  await page.getByLabel('Durée étape 1 en secondes', { exact: true }).fill('61');
  await page.getByRole('button', { name: "Lancer l'aperçu" }).click();
  await expect(page.getByRole('alert')).toContainText('hors limites');
  await page.getByLabel('Durée étape 1 en secondes', { exact: true }).fill('60');
  await page.getByRole('button', { name: "Lancer l'aperçu" }).click();
  await page.getByLabel('Modèle de robot').selectOption('tesla-optimus');
  await expect(page.getByRole('button', { name: "Arrêter l'aperçu" })).toHaveCount(0);
  await page.getByRole('button', { name: 'Essayer le simulateur' }).click();
  await expect(page.getByText('Prêt pour un aperçu', { exact: true })).toBeVisible();
});

test('routine réutilisable : ajout, ordre, export et réimport fidèle', async ({ page }, testInfo) => {
  await prepare(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/dashboard/robots');
  await page.getByRole('button', { name: 'Essayer le simulateur' }).click();
  await page.getByLabel('Nom de la routine').fill('Routine réutilisable');
  await page.getByLabel('Texte étape 1', { exact: true }).fill('Bonjour à tous 🌍');
  await page.getByLabel('Durée étape 1 en secondes', { exact: true }).fill('1.234');
  await page.getByLabel('Geste étape 2', { exact: true }).selectOption('attention');
  await page.getByRole('button', { name: 'Ajouter : parole', exact: true }).click();
  await page.getByLabel('Texte étape 4', { exact: true }).fill('À bientôt.');
  await page.getByLabel('Durée étape 4 en secondes', { exact: true }).fill('0.001');
  await page.getByRole('button', { name: 'Monter étape 4', exact: true }).click();
  await page.getByRole('button', { name: 'Supprimer étape 4', exact: true }).click();
  await expect(page.getByLabel('Texte étape 3', { exact: true })).toHaveValue('À bientôt.');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exporter la routine' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('purama-routine.json');
  const buffer = await readFile((await download.path())!);
  const exported = JSON.parse(buffer.toString('utf-8'));
  expect(Object.keys(exported)).toEqual(['format', 'version', 'name', 'steps']);
  expect(exported.steps.map((step: { kind: string }) => step.kind)).toEqual(['speech', 'gesture', 'speech']);
  expect(exported.steps.map((step: { durationMs: number }) => step.durationMs)).toEqual([1234, 2000, 1]);
  expect(exported.steps[1].gesture).toBe('attention');
  await page.getByLabel('Modèle de robot').selectOption('tesla-optimus');
  await page.getByRole('button', { name: 'Essayer le simulateur' }).click();
  await expect(page.getByLabel('Nom de la routine')).toHaveValue('Bienvenue');
  await page.getByLabel('Importer une routine PURAMA').setInputFiles({ name: 'routine.json', mimeType: 'application/json', buffer });
  await expect(page.getByLabel('Nom de la routine')).toHaveValue('Routine réutilisable');
  await expect(page.getByLabel('Durée étape 1 en secondes', { exact: true })).toHaveValue('1.234');
  await expect(page.getByLabel('Geste étape 2', { exact: true })).toHaveValue('attention');
  await expect(page.getByLabel('Durée étape 3 en secondes', { exact: true })).toHaveValue('0.001');
  await expect(page.getByText('Prêt pour un aperçu', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('robot-routine-editor.png'), fullPage: true });
  await page.getByRole('button', { name: "Lancer l'aperçu" }).click();
  await expect(page.getByTestId('robot-active-step')).toHaveText('Bonjour à tous 🌍');
  await page.getByRole('button', { name: "Arrêter l'aperçu" }).click();
  expect(errors).toEqual([]);
});

test('import refusé : JSON, taille et action inconnue préservent le brouillon', async ({ page }) => {
  await prepare(page);
  await page.goto('/dashboard/robots');
  await page.getByRole('button', { name: 'Essayer le simulateur' }).click();
  await page.getByLabel('Nom de la routine').fill('Mon brouillon');
  await page.getByLabel('Texte étape 1', { exact: true }).fill('À conserver');
  const invalid = [
    '{',
    ' '.repeat(512_001),
    JSON.stringify({ format: 'purama.robot.routine', version: 1, name: 'Refusé', steps: [{ id: 'move', kind: 'move', durationMs: 1000 }] }),
  ];
  for (const text of invalid) {
    await page.getByLabel('Importer une routine PURAMA').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await expect(page.getByRole('alert')).toContainText('Votre routine actuelle est conservée.');
    await expect(page.getByLabel('Nom de la routine')).toHaveValue('Mon brouillon');
    await expect(page.getByLabel('Texte étape 1', { exact: true })).toHaveValue('À conserver');
    await expect(page.getByText('Prêt pour un aperçu', { exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: "Lancer l'aperçu" }).click();
  await expect(page.getByTestId('robot-active-step')).toHaveText('À conserver');
});

test('limite de 24 étapes et identifiants stables après suppression et ajout', async ({ page }) => {
  await prepare(page);
  await page.goto('/dashboard/robots');
  await page.getByRole('button', { name: 'Essayer le simulateur' }).click();
  const input = { format: 'purama.robot.routine', version: 1, name: '24 étapes', steps: Array.from({ length: 24 }, (_, index) => ({ id: `step-${index + 1}`, kind: 'pause', durationMs: 1, required: index !== 0 })) };
  await page.getByLabel('Importer une routine PURAMA').setInputFiles({ name: '24.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(input)) });
  await expect(page.getByRole('list', { name: 'Étapes de la routine' }).getByRole('listitem')).toHaveCount(24);
  await expect(page.getByRole('button', { name: 'Ajouter : pause', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Supprimer étape 2', exact: true }).click();
  await page.getByRole('button', { name: 'Ajouter : pause', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exporter la routine' }).click();
  const exported = JSON.parse(await readFile((await (await downloadPromise).path())!, 'utf-8'));
  expect(new Set(exported.steps.map((step: { id: string }) => step.id)).size).toBe(24);
  expect(exported.steps[0].required).toBe(false);
  expect(exported.steps[23].id).toBe('step-2');
});

test('import en cours : édition verrouillée et résultat ignoré après sortie', async ({ page }) => {
  await prepare(page);
  await page.goto('/dashboard/robots');
  await page.getByRole('button', { name: 'Essayer le simulateur' }).click();
  await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = function () {
      return new Promise<string>((resolve, reject) => {
        (window as unknown as { finishFileRead: () => Promise<void> }).finishFileRead = async () => {
          try { resolve(await original.call(this)); } catch (error) { reject(error); }
        };
      });
    };
  });
  const input = { format: 'purama.robot.routine', version: 1, name: 'Ancien import', steps: [{ id: 'pause', kind: 'pause', durationMs: 1000 }] };
  await page.getByLabel('Importer une routine PURAMA').setInputFiles({ name: 'held.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(input)) });
  await expect(page.getByText('Lecture et validation du fichier…', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Nom de la routine')).toBeDisabled();
  await expect(page.getByRole('button', { name: "Lancer l'aperçu" })).toBeDisabled();
  await page.getByLabel('Modèle de robot').selectOption('tesla-optimus');
  await page.getByRole('button', { name: 'Essayer le simulateur' }).click();
  await page.evaluate(async () => {
    await (window as unknown as { finishFileRead: () => Promise<void> }).finishFileRead();
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect(page.getByLabel('Nom de la routine')).toHaveValue('Bienvenue');
  await expect(page.getByText('Routine importée.', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: "Lancer l'aperçu" })).toBeEnabled();
});
