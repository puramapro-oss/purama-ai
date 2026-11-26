# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: network.spec.ts >> la conversation garde la demande, valide la provenance du reçu et propose les expériences qualifiées
- Location: tests/chat/science.spec.ts:3:1

# Error details

```
Error: expect(locator).toHaveAttribute(expected) failed

Locator: locator('iframe[title="Simulation 3D du pendule simple"]')
Expected: "xr-spatial-tracking 'src'; fullscreen 'src'"
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toHaveAttribute" locator('iframe[title="Simulation 3D du pendule simple"]') with timeout 5000ms
  - waiting for locator('iframe[title="Simulation 3D du pendule simple"]')

```

```yaml
- dialog "Conversation avec PURA":
  - img
  - heading "PURA" [level=3]
  - paragraph: Votre assistant
  - button "Nouvelle conversation":
    - img
  - button "Fermer l'assistant":
    - img
  - log:
    - img
    - paragraph: Bonjour, je suis PURA. Décrivez ce que vous souhaitez faire.
    - img
    - paragraph: Simule un pendule de 80 cm à 12 degrés
    - img
    - paragraph: "Atelier du pendule simple. Réglages transmis : longueur (m) 0,8, angle (°) 12. Le rapport distingue la prévision du modèle et vos mesures réelles."
    - status: Connexion nécessaire pour ouvrir l’atelier. Les paramètres de votre demande sont conservés ici.
  - button "Essaie-le pour moi"
  - textbox "Votre message":
    - /placeholder: Posez votre question...
  - button "Envoyer le message" [disabled]:
    - img
- heading "Regarde un employé IA travailler" [level=2]
- paragraph: Décris une situation, l'employé Email de Purama AI rédige un vrai brouillon — sans inscription.
- textbox "Décris une situation d'email professionnel":
  - /placeholder: "Ex : Relancer un client qui n'a pas payé sa facture..."
- button "Générer" [disabled]:
  - img
  - text: Générer
- button "Relancer un client qui n'a pas payé sa facture depuis 30 jours"
- button "M'excuser auprès d'un client pour un retard de livraison"
- button "Répondre à un prospect qui demande une réduction de prix"
```

# Test source

```ts
  1  | import { test, expect } from './fixtures';
  2  |
  3  | test('la conversation garde la demande, valide la provenance du reçu et propose les expériences qualifiées', async ({ page }) => {
  4  |   await page.route('https://one.example.invalid/atelier-spatial/pendule**', route => route.fulfill({
  5  |     contentType: 'text/html', body: `<!doctype html><button id="report">Calculer</button><button id="clear">Effacer</button><script>
  6  |       let chatOrigin;
  7  |       addEventListener('message', e => {
  8  |         if (e.source !== parent || e.data !== 'purama:pendulum:probe:v1') return;
  9  |         chatOrigin = e.origin;
  10 |         parent.postMessage('purama:pendulum:ready:v1', chatOrigin);
  11 |       });
  12 |       report.onclick = () => parent.postMessage({type:'purama:pendulum:result:v1',report:{
  13 |         periodSeconds:1.823, trials:100, modelId:'pendulum-v1', measuredPeriodSeconds:1.9
  14 |       }},chatOrigin);
  15 |       clear.onclick = () => parent.postMessage({type:'purama:pendulum:result:v1',report:null},chatOrigin);
  16 |     </script>`,
  17 |   }));
  18 |   await page.route('https://one.example.invalid/atelier-spatial/correlation', route => route.fulfill({
  19 |     contentType: 'text/html', body: `<!doctype html><p>Comparaison de qualification</p><script>
  20 |       addEventListener('message', e => {
  21 |         if (e.source !== parent || e.data !== 'purama:correlation:probe:v1') return;
  22 |         parent.postMessage('purama:correlation:ready:v1', e.origin);
  23 |         parent.postMessage({type:'purama:pendulum:result:v1',report:{periodSeconds:99,trials:10,modelId:'fake'}},e.origin);
  24 |       });
  25 |     </script>`,
  26 |   }));
  27 |   await page.goto('/tests/chat/index.html');
  28 |   await page.getByRole('button', { name: "Ouvrir l'assistant PURA" }).click();
  29 |   const send = async (text: string) => {
  30 |     await page.getByRole('textbox', { name: 'Votre message' }).fill(text);
  31 |     await page.getByRole('button', { name: 'Envoyer le message' }).click();
  32 |   };
  33 |   await send('Simule un pendule de 80 cm à 12 degrés');
  34 |   const iframe = page.locator('iframe[title="Simulation 3D du pendule simple"]');
> 35 |   await expect(iframe).toHaveAttribute('allow', "xr-spatial-tracking 'src'; fullscreen 'src'");
     |                        ^ Error: expect(locator).toHaveAttribute(expected) failed
  36 |   await expect(iframe).toHaveAttribute('src', 'https://one.example.invalid/atelier-spatial/pendule?lengthMeters=0.8&angleDegrees=12');
  37 |   await expect(page.getByText('Connexion à l’atelier…')).toBeHidden();
  38 |   await page.evaluate(() => {
  39 |     window.dispatchEvent(new MessageEvent('message', { origin: 'https://one.example.invalid', source: window,
  40 |       data: { type: 'purama:pendulum:result:v1', report: { periodSeconds: 99, trials: 2, modelId: 'fake' } } }));
  41 |   });
  42 |   await expect(page.getByText(/Période simulée/)).toHaveCount(0);
  43 |   const frame = page.frameLocator('iframe[title="Simulation 3D du pendule simple"]');
  44 |   await frame.getByText('Calculer').click();
  45 |   await expect(page.getByText('1,823 s', { exact: true })).toBeVisible();
  46 |   await expect(page.getByText(/Période issue de votre mesure/)).toContainText('1,9 s');
  47 |   await frame.getByText('Effacer').click();
  48 |   await expect(page.getByText(/Période simulée/)).toHaveCount(0);
  49 |   await send('Simule un pendule de 50 cm');
  50 |   await expect(iframe).toHaveCount(1);
  51 |   await expect(iframe).toHaveAttribute('src', /lengthMeters=0.5$/);
  52 |   await page.getByRole('button', { name: 'Reprendre cette simulation' }).click();
  53 |   await expect(iframe).toHaveAttribute('src', /lengthMeters=0.8&angleDegrees=12$/);
  54 |   await send('Simule un pendule double');
  55 |   await expect(page.getByRole('link', { name: 'Préparer le protocole' })).toHaveAttribute('href', 'https://one.example.invalid/atelier-spatial/projet');
  56 |   await send('Compare mes deux séries numériques');
  57 |   await expect(page.getByRole('link', { name: 'Ouvrir l’atelier de corrélation en pleine page' })).toHaveAttribute('href', 'https://one.example.invalid/atelier-spatial/correlation');
  58 |   await expect(page.locator('iframe[title="Comparaison de deux séries numériques"]')).toHaveAttribute('allow', "xr-spatial-tracking 'src'; fullscreen 'src'");
  59 |   await expect(page.frameLocator('iframe[title="Comparaison de deux séries numériques"]').getByText('Comparaison de qualification')).toBeVisible();
  60 |   await expect(page.getByText('Connexion à l’atelier…')).toBeHidden();
  61 |   await expect(page.locator('iframe')).toHaveCount(1);
  62 |   await expect(page.getByText(/Période simulée/)).toHaveCount(0);
  63 |   expect(await page.evaluate(() => window.__chatHarness.calls.filter(c => c.key === 'chatbot'))).toHaveLength(0);
  64 | });
  65 |
  66 | test('hors connexion et historique authentifié préservent la demande sans charger un ancien modèle', async ({ page }) => {
  67 |   await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
  68 |   await page.goto('/tests/chat/index.html');
  69 |   await page.evaluate(() => window.__chatHarness.setIdentity({ id: 'alice', email: 'alice@example.invalid' }));
  70 |   await page.getByRole('button', { name: "Ouvrir l'assistant PURA" }).click();
  71 |   const goal = 'Simule un pendule de 50 cm';
  72 |   await page.getByRole('textbox', { name: 'Votre message' }).fill(goal);
  73 |   await page.getByRole('button', { name: 'Envoyer le message' }).click();
  74 |   await expect(page.getByText(/Connexion nécessaire pour ouvrir l’atelier/)).toBeVisible();
  75 |   await expect(page.locator('iframe')).toHaveCount(0);
  76 |   await expect.poll(() => page.evaluate(() => window.__chatHarness.calls.filter(call => call.key === 'write').length)).toBe(2);
  77 |   await page.evaluate(() => {
  78 |     const saved = window.__chatHarness.calls.filter(call => call.key === 'write')
  79 |       .map(call => ({ ...call.body, created_at: '2026-01-01T00:00:00Z' }));
  80 |     window.__chatHarness.plans.messages = [{ json: saved }];
  81 |   });
  82 |   await page.getByRole('button', { name: 'Nouvelle conversation' }).click();
  83 |   await page.getByRole('button', { name: 'Historique des conversations' }).click();
  84 |   await page.getByRole('button', { name: /Conversation précédente/ }).click();
  85 |   await expect(page.getByText(goal, { exact: true })).toBeVisible();
  86 |   await expect(page.locator('iframe')).toHaveCount(0);
  87 |   await page.getByRole('button', { name: 'Reprendre cette simulation' }).click();
  88 |   await expect(page.getByText(/Connexion nécessaire pour ouvrir l’atelier/)).toBeVisible();
  89 |   await page.evaluate(() => window.__chatHarness.setIdentity({ id: 'bob', email: 'bob@example.invalid' }));
  90 |   await expect(page.getByText(goal, { exact: true })).toHaveCount(0);
  91 |   await expect(page.getByRole('button', { name: 'Reprendre cette simulation' })).toHaveCount(0);
  92 | });
  93 |
```
