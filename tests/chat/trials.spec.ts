import { test, expect, type Page } from './fixtures';

const entry = '/tests/chat/index.html';
const openChat = (page: Page) => page.getByRole('button', { name: "Ouvrir l'assistant PURA" }).click();
const launch = (page: Page) => page.getByRole('button', { name: 'Essaie-le pour moi', exact: true }).click();

test('une commande locale conserve le brouillon, calcule un panier exact et permet de réviser le stock', async ({ page }) => {
  await page.goto(entry);
  await openChat(page);
  const prompt = 'Essaie-le pour moi : un panier de exactement 23 pièces avec un budget de 28 €. ';
  await page.getByRole('textbox', { name: 'Votre message' }).fill(prompt);
  await page.getByRole('button', { name: 'Envoyer le message' }).click();
  await expect(page.getByLabel('Pièces souhaitées')).toHaveValue('23');
  await expect(page.getByText(/Panier confirmé pour exactement 23 pièces à 27/)).toBeVisible();
  await page.getByRole('button', { name: 'Et si ça change ?' }).click();
  await expect(page.getByText(/Avec le stock indiqué, il manque/)).toContainText(/1\s*€/);
  await page.getByLabel('Stock supposé (lots)').fill('3');
  await expect(page.getByText(/Panier confirmé pour exactement 23 pièces à 27/)).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toHaveValue(prompt);
  expect(await page.evaluate(() => window.__chatHarness.calls)).toHaveLength(0);
});

test('la navigation des méthodes conserve la saisie locale et le changement de compte la ferme', async ({ page }) => {
  await page.goto(entry);
  await openChat(page);
  await launch(page);
  await page.getByRole('button', { name: /^Préparer un atelier/ }).click();
  const confirmations = page.getByLabel('Confirmations uniques déclarées', {exact: false});
  await confirmations.fill('5');
  await expect(page.getByText(/le solde après coûts serait/)).toContainText(/-20,00/);
  await page.getByRole('button', { name: 'Tous les essais' }).click();
  await page.getByRole('button', { name: /^Préparer un atelier/ }).click();
  await expect(confirmations).toHaveValue('5');
  await page.evaluate(() => window.__chatHarness.setIdentity({ id: 'compte-suivant', email: 'autre@example.invalid' }));
  await expect(page.getByRole('heading', {name:'Préparer un atelier'})).toBeHidden();
  await launch(page);
  await page.getByRole('button', { name: /^Préparer un atelier/ }).click();
  await expect(confirmations).toHaveValue('');
});

test('le lien de méthode ouvre uniquement la méthode et revient au chat', async ({ page }) => {
  await page.goto(entry + '#essai/atelier');
  await expect(page.getByRole('dialog', { name: 'Préparer un atelier' })).toBeVisible();
  await expect(page.getByText(/Seuil de couverture : 6 places payantes/)).toBeVisible();
  const confirmations = page.getByLabel('Confirmations uniques déclarées', {exact: false});
  await confirmations.fill('5');
  await page.evaluate(() => window.__chatHarness.setIdentity({ id: 'session-restauree', email: 'restore@example.invalid' }));
  await expect(confirmations).toHaveValue('');
  await page.evaluate(() => { window.location.hash = 'essai/media'; });
  await expect(page.getByLabel('Original', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/#essai/);
  await openChat(page);
  await launch(page);
  await expect(page.getByRole('button', {name: /^Composer un panier/})).toBeVisible();
});

test('création locale d’une variante sur la largeur mobile et téléchargement', async ({ page }) => {
  await page.setViewportSize({width: 375, height: 812});
  await page.goto(entry + '#essai/media');
  const original = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 160;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(160,160);
    for (let i = 0; i < img.data.length; i+=4) {
      img.data[i] = (i >> 2) % 251;
      img.data[i+1] = (i >> 4) % 247;
      img.data[i+2] = (i >> 8) % 241;
      img.data[i+3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('Original', {exact:true}).setInputFiles({ name:'illustration.png', mimeType:'image/png', buffer:Buffer.from(original,'base64') });
  await page.getByRole('button', {name:'Créer une variante locale'}).click();
  const download = page.waitForEvent('download');
  await page.getByRole('link', {name:'Télécharger la variante'}).click();
  expect((await download).suggestedFilename()).toBe('illustration-iao-76.webp');
  await expect(page.getByText(/Poids maximal par variante/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.getByRole('button',{name:'Réinitialiser l’essai'}).click();
  await expect(page.getByRole('link',{name:'Télécharger la variante'})).toBeHidden();
});

test('quitter un essai met les vidéos en pause et conserve les fichiers et la position au retour', async ({ page }, testInfo) => {
  await page.goto(entry + '#essai/media');
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d')!;
    const stream = canvas.captureStream(12);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks: Blob[] = [];
    let frame = 0;
    const paint = () => {
      context.fillStyle = frame++ % 2 ? '#6c4b9c' : '#f2ba6b';
      context.fillRect(0, 0, canvas.width, canvas.height);
    };
    paint();
    const interval = window.setInterval(paint, 70);
    try {
      await new Promise<void>((resolve, reject) => {
        recorder.ondataavailable = event => chunks.push(event.data);
        recorder.onerror = () => reject(new Error('La vidéo de qualification ne peut pas être enregistrée.'));
        recorder.onstop = () => resolve();
        recorder.start();
        window.setTimeout(() => recorder.stop(), 700);
      });
      return Array.from(new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()));
    } finally {
      window.clearInterval(interval);
      stream.getTracks().forEach(track => track.stop());
    }
  });
  const buffer = Buffer.from(bytes);
  await page.getByLabel('Original', { exact: true }).setInputFiles({ name: 'source.webm', mimeType: 'video/webm', buffer });
  await page.getByLabel('Ajouter des variantes', { exact: true }).setInputFiles([
    { name: 'variante-a.webm', mimeType: 'video/webm', buffer },
    { name: 'variante-b.webm', mimeType: 'video/webm', buffer },
  ]);

  const original = page.getByLabel('Original sélectionné – source.webm', { exact: true });
  const firstVariant = page.getByLabel('Variante sélectionnée – variante-a.webm', { exact: true });
  await expect(original).toBeVisible();
  await expect(firstVariant).toBeVisible();
  await original.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    element.loop = true;
    await element.play();
  });
  await firstVariant.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    element.loop = true;
    await element.play();
  });
  await expect.poll(() => original.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
  await expect.poll(() => firstVariant.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);

  const previousVariant = await firstVariant.elementHandle();
  expect(previousVariant).not.toBeNull();
  await page.getByLabel('Variante à comparer').selectOption('1');
  await expect.poll(() => previousVariant!.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  // Comparing the original with the selected variant remains an intentional choice.
  expect(await original.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
  const secondVariant = page.getByLabel('Variante sélectionnée – variante-b.webm', { exact: true });
  await expect(secondVariant).toBeVisible();
  await secondVariant.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    element.loop = true;
    await element.play();
  });

  await page.getByRole('button', { name: 'Tous les essais', exact: true }).click();
  await expect(original).toBeHidden();
  await expect.poll(() => original.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await expect.poll(() => secondVariant.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  const positions = await Promise.all([original, secondVariant].map(video => video.evaluate((element: HTMLVideoElement) => element.currentTime)));
  await page.getByRole('button', { name: /^Préparer un atelier/ }).click();
  await page.getByLabel('Confirmations uniques déclarées', { exact: false }).fill('5');
  await page.getByRole('button', { name: 'Tous les essais', exact: true }).click();
  await page.getByRole('button', { name: /^Comparer des médias/ }).click();

  await expect(original).toBeVisible();
  await expect(secondVariant).toBeVisible();
  await expect(page.getByLabel('Variante à comparer')).toHaveValue('1');
  for (const [index, video] of [original, secondVariant].entries()) {
    expect(await video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
    expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(positions[index], 3);
  }
  expect(await page.evaluate(() => window.__chatHarness.calls)).toHaveLength(0);
  await testInfo.attach('video-return-state', {
    body: Buffer.from(JSON.stringify({
      localVideoBytes: buffer.length,
      positionsOnLeaving: positions,
      selectedVariant: await page.getByLabel('Variante à comparer').inputValue(),
      videos: await Promise.all([original, secondVariant].map(video => video.evaluate((element: HTMLVideoElement) => ({
        label: element.getAttribute('aria-label'), paused: element.paused, currentTime: element.currentTime,
        width: element.videoWidth, height: element.videoHeight, duration: element.duration,
      })))),
    }, null, 2)),
    contentType: 'application/json',
  });
  await page.screenshot({ path: testInfo.outputPath('media-return.png'), fullPage: true });
  await original.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('media-preview-return.png'), fullPage: true });
  await previousVariant!.dispose();
});
