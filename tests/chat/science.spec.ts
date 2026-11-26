import { test, expect } from './fixtures';

test('la conversation garde la demande, valide la provenance du reçu et propose les expériences qualifiées', async ({ page }) => {
  await page.route('https://one.example.invalid/atelier-spatial/pendule**', route => route.fulfill({
    contentType: 'text/html', body: `<!doctype html><button id="report">Calculer</button><button id="clear">Effacer</button><script>
      let chatOrigin;
      addEventListener('message', e => {
        if (e.source !== parent || e.data !== 'purama:pendulum:probe:v1') return;
        chatOrigin = e.origin;
        parent.postMessage('purama:pendulum:ready:v1', chatOrigin);
      });
      report.onclick = () => parent.postMessage({type:'purama:pendulum:result:v1',report:{
        periodSeconds:1.823, trials:100, modelId:'pendulum-v1', measuredPeriodSeconds:1.9
      }},chatOrigin);
      clear.onclick = () => parent.postMessage({type:'purama:pendulum:result:v1',report:null},chatOrigin);
    </script>`,
  }));
  await page.route('https://one.example.invalid/atelier-spatial/correlation', route => route.fulfill({
    contentType: 'text/html', body: `<!doctype html><p>Comparaison de qualification</p><script>
      addEventListener('message', e => {
        if (e.source !== parent || e.data !== 'purama:correlation:probe:v1') return;
        parent.postMessage('purama:correlation:ready:v1', e.origin);
        parent.postMessage({type:'purama:pendulum:result:v1',report:{periodSeconds:99,trials:10,modelId:'fake'}},e.origin);
      });
    </script>`,
  }));
  await page.goto('/tests/chat/index.html');
  await page.getByRole('button', { name: "Ouvrir l'assistant PURA" }).click();
  const send = async (text: string) => {
    await page.getByRole('textbox', { name: 'Votre message' }).fill(text);
    await page.getByRole('button', { name: 'Envoyer le message' }).click();
  };
  await send('Simule un pendule de 80 cm à 12 degrés');
  const iframe = page.locator('iframe[title="Simulation 3D du pendule simple"]');
  await expect(iframe).toHaveAttribute('allow', "xr-spatial-tracking 'src'; fullscreen 'src'");
  await expect(iframe).toHaveAttribute('src', 'https://one.example.invalid/atelier-spatial/pendule?lengthMeters=0.8&angleDegrees=12');
  await expect(page.getByText('Connexion à l’atelier…')).toBeHidden();
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://one.example.invalid', source: window,
      data: { type: 'purama:pendulum:result:v1', report: { periodSeconds: 99, trials: 2, modelId: 'fake' } } }));
  });
  await expect(page.getByText(/Période simulée/)).toHaveCount(0);
  const frame = page.frameLocator('iframe[title="Simulation 3D du pendule simple"]');
  await frame.getByText('Calculer').click();
  await expect(page.getByText('1,823 s', { exact: true })).toBeVisible();
  await expect(page.getByText(/Période issue de votre mesure/)).toContainText('1,9 s');
  await frame.getByText('Effacer').click();
  await expect(page.getByText(/Période simulée/)).toHaveCount(0);
  await send('Simule un pendule de 50 cm');
  await expect(iframe).toHaveCount(1);
  await expect(iframe).toHaveAttribute('src', /lengthMeters=0.5$/);
  await page.getByRole('button', { name: 'Reprendre cette simulation' }).click();
  await expect(iframe).toHaveAttribute('src', /lengthMeters=0.8&angleDegrees=12$/);
  await send('Simule un pendule double');
  await expect(page.getByRole('link', { name: 'Préparer le protocole' })).toHaveAttribute('href', 'https://one.example.invalid/atelier-spatial/projet');
  await send('Compare mes deux séries numériques');
  await expect(page.getByRole('link', { name: 'Ouvrir l’atelier de corrélation en pleine page' })).toHaveAttribute('href', 'https://one.example.invalid/atelier-spatial/correlation');
  await expect(page.locator('iframe[title="Comparaison de deux séries numériques"]')).toHaveAttribute('allow', "xr-spatial-tracking 'src'; fullscreen 'src'");
  await expect(page.frameLocator('iframe[title="Comparaison de deux séries numériques"]').getByText('Comparaison de qualification')).toBeVisible();
  await expect(page.getByText('Connexion à l’atelier…')).toBeHidden();
  await expect(page.locator('iframe')).toHaveCount(1);
  await expect(page.getByText(/Période simulée/)).toHaveCount(0);
  expect(await page.evaluate(() => window.__chatHarness.calls.filter(c => c.key === 'chatbot'))).toHaveLength(0);
});

test('hors connexion et historique authentifié préservent la demande sans charger un ancien modèle', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
  await page.goto('/tests/chat/index.html');
  await page.evaluate(() => window.__chatHarness.setIdentity({ id: 'alice', email: 'alice@example.invalid' }));
  await page.getByRole('button', { name: "Ouvrir l'assistant PURA" }).click();
  const goal = 'Simule un pendule de 50 cm';
  await page.getByRole('textbox', { name: 'Votre message' }).fill(goal);
  await page.getByRole('button', { name: 'Envoyer le message' }).click();
  await expect(page.getByText(/Connexion nécessaire pour ouvrir l’atelier/)).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__chatHarness.calls.filter(call => call.key === 'write').length)).toBe(2);
  await page.evaluate(() => {
    const saved = window.__chatHarness.calls.filter(call => call.key === 'write')
      .map(call => ({ ...call.body, created_at: '2026-01-01T00:00:00Z' }));
    window.__chatHarness.plans.messages = [{ json: saved }];
  });
  await page.getByRole('button', { name: 'Nouvelle conversation' }).click();
  await page.getByRole('button', { name: 'Historique des conversations' }).click();
  await page.getByRole('button', { name: /Conversation précédente/ }).click();
  await expect(page.getByText(goal, { exact: true })).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reprendre cette simulation' }).click();
  await expect(page.getByText(/Connexion nécessaire pour ouvrir l’atelier/)).toBeVisible();
  await page.evaluate(() => window.__chatHarness.setIdentity({ id: 'bob', email: 'bob@example.invalid' }));
  await expect(page.getByText(goal, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reprendre cette simulation' })).toHaveCount(0);
});
