# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: email-lifecycle.spec.ts >> email settings: A-B-A ignores an old disconnect receipt and keeps the new connection
- Location: tests/ui-state/email-lifecycle.spec.ts:74:1

# Error details

```
Error: expect(locator).toHaveCount(expected) failed

Locator:  getByText('Gmail déconnecté', { exact: true })
Expected: 0
Received: 1
Timeout:  1500ms

Call log:
  - Expect "toHaveCount" with timeout 1500ms
  - waiting for getByText('Gmail déconnecté', { exact: true })
    5 × locator resolved to 1 element
      - unexpected value "1"

```

# Page snapshot

```yaml
- generic [ref=e2]:
  - generic [ref=e3]:
    - generic [ref=e4]:
      - generic [ref=e5]:
        - link "Retour" [ref=e6] [cursor=pointer]:
          - /url: /dashboard/email-agent
          - img [ref=e7]
          - text: Retour
        - heading "Paramètres de l'agent" [level=1] [ref=e9]
      - button "Enregistrer" [ref=e10] [cursor=pointer]:
        - img
        - text: Enregistrer
    - generic [ref=e12]:
      - heading "Compte Gmail" [level=2] [ref=e13]:
        - img [ref=e14]
        - text: Compte Gmail
      - generic [ref=e17]:
        - generic [ref=e18]:
          - paragraph [ref=e19]: current-a@fixture.invalid
          - paragraph [ref=e20]: Connecté ✅
        - button "Déconnecter" [ref=e21] [cursor=pointer]:
          - img
          - text: Déconnecter
    - generic [ref=e23]:
      - heading "Voix & ton" [level=2] [ref=e24]
      - generic [ref=e25]:
        - text: Ton de réponse
        - combobox [ref=e26] [cursor=pointer]:
          - generic:
            - text: Professionnel amical
            - generic: — Le défaut. Chaleureux mais pro.
          - img [ref=e27]
      - generic [ref=e29]:
        - text: Signature email
        - 'textbox "Ex : Matiss Dornier Fondateur — Purama matiss@purama.dev" [ref=e30]':
          - /placeholder: "Ex :\nMatiss Dornier\nFondateur — Purama\nmatiss@purama.dev"
          - text: CURRENT-A
      - generic [ref=e31]:
        - text: Langue de réponse
        - combobox [ref=e32] [cursor=pointer]:
          - generic: Français
          - img [ref=e33]
    - generic [ref=e36]:
      - heading "Horaires & rapports" [level=2] [ref=e37]
      - generic [ref=e38]:
        - generic [ref=e39]:
          - paragraph [ref=e40]: Heures de travail uniquement
          - paragraph [ref=e41]: L'agent ne répond qu'aux heures définies.
        - switch [ref=e42] [cursor=pointer]
      - generic [ref=e43]:
        - generic [ref=e44]:
          - paragraph [ref=e45]: Rapport quotidien
          - paragraph [ref=e46]: Reçois un récap chaque matin.
        - switch [checked] [ref=e47] [cursor=pointer]
      - generic [ref=e48]:
        - text: Heure du rapport
        - textbox [ref=e49]: 08:00
    - generic [ref=e52]:
      - heading "Mode vacances" [level=2] [ref=e53]:
        - img [ref=e54]
        - text: Mode vacances
      - switch [ref=e56] [cursor=pointer]
    - generic [ref=e58]:
      - heading "Exclusions" [level=2] [ref=e59]
      - paragraph [ref=e60]: L'agent ignorera totalement ces emails et domaines.
      - generic [ref=e61]:
        - text: Emails exclus
        - generic [ref=e62]:
          - textbox "exemple@domaine.com" [ref=e63]
          - button [ref=e64] [cursor=pointer]:
            - img
      - generic [ref=e65]:
        - text: Domaines exclus
        - generic [ref=e66]:
          - textbox "domaine.com" [ref=e67]
          - button [ref=e68] [cursor=pointer]:
            - img
  - region "Notifications alt+T":
    - list:
      - listitem [ref=e69]:
        - img [ref=e71]
        - generic [ref=e74]: Gmail déconnecté
```

# Test source

```ts
  1   | import { expect, test, type Page } from '@playwright/test';
  2   | 
  3   | const A = '00000000-0000-4000-8000-000000000001';
  4   | const B = '00000000-0000-4000-8000-000000000002';
  5   | const signature = 'textarea[placeholder^="Ex :"]';
  6   | const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve =>
  7   |   requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  8   | 
  9   | test.beforeEach(async ({ page }, testInfo) => {
  10  |   const origin = new URL(String(testInfo.project.use.baseURL)).origin;
  11  |   await page.route('**/*', route => new URL(route.request().url()).origin === origin
  12  |     ? route.continue() : route.abort('blockedbyclient'));
  13  |   await page.routeWebSocket('**/*', socket => socket.close());
  14  |   await page.addInitScript(() => {
  15  |     localStorage.setItem('tuto-email-agent', '1');
  16  |     Object.assign(window, { lifecycleUnhandled: [] as string[] });
  17  |     window.addEventListener('unhandledrejection', event => {
  18  |       (window as unknown as { lifecycleUnhandled: string[] }).lifecycleUnhandled.push(String(event.reason));
  19  |       event.preventDefault();
  20  |     });
  21  |   });
  22  | });
  23  | 
  24  | test.afterEach(async ({ page }) => {
  25  |   expect(await page.evaluate(() => (window as unknown as { lifecycleUnhandled: string[] }).lifecycleUnhandled)).toEqual([]);
  26  | });
  27  | 
  28  | async function waitConfig(page: Page, owner: string, count = 1) {
  29  |   await expect.poll(() => page.evaluate(owner => window.uiStateHarness.pending.filter(p =>
  30  |     !p.done && p.table === 'email_agent_config' && p.ownerId === owner).length, owner)).toBe(count);
  31  | }
  32  | 
  33  | async function resolveConfig(page: Page, owner: string, marker: string, connected = false, latest = false) {
  34  |   await page.evaluate(({ owner, marker, connected, latest }) => window.uiStateHarness.resolveConfig(
  35  |     'email_agent_config', owner, marker,
  36  |     connected ? { gmail_email: `${marker.toLowerCase()}@fixture.invalid` } : {}, latest,
  37  |   ), { owner, marker, connected, latest });
  38  | }
  39  | 
  40  | async function switchAndLoad(page: Page, owner: string, marker: string, connected = false) {
  41  |   await page.evaluate(owner => window.uiStateHarness.setIdentity(owner), owner);
  42  |   await waitConfig(page, owner);
  43  |   await resolveConfig(page, owner, marker, connected);
  44  | }
  45  | 
  46  | async function waitWrites(page: Page, count: number) {
  47  |   await expect.poll(() => page.evaluate(() => window.uiStateHarness.pendingWrites.length)).toBe(count);
  48  | }
  49  | 
  50  | test('email settings: A-B-A ignores an old save receipt and retains the current pending save', async ({ page }) => {
  51  |   await page.goto('/tests/ui-state/index.html?page=email');
  52  |   await waitConfig(page, A); await resolveConfig(page, A, 'FIRST-A');
  53  |   await page.evaluate(() => { window.uiStateHarness.deferWrites = true; });
  54  |   await page.locator(signature).fill('OLD-SAVE-A');
  55  |   await page.getByRole('button', { name: 'Enregistrer', exact: true }).click(); await waitWrites(page, 1);
  56  | 
  57  |   await switchAndLoad(page, B, 'PRIVATE-B');
  58  |   await switchAndLoad(page, A, 'CURRENT-A');
  59  |   await page.locator(signature).fill('CURRENT-DRAFT-A');
  60  |   const save = page.getByRole('button', { name: 'Enregistrer', exact: true });
  61  |   await save.click(); await waitWrites(page, 2);
  62  |   await page.evaluate(() => window.uiStateHarness.resolveWrite(0)); await settle(page);
  63  |   await expect(page.getByText('✅ Paramètres enregistrés', { exact: true })).toHaveCount(0);
  64  |   await expect(page.locator(signature)).toHaveValue('CURRENT-DRAFT-A');
  65  |   await expect(save).toBeDisabled();
  66  | 
  67  |   await page.evaluate(() => window.uiStateHarness.resolveWrite(1));
  68  |   await expect(page.getByText('✅ Paramètres enregistrés', { exact: true })).toBeVisible();
  69  |   await expect(save).toBeEnabled();
  70  |   expect(await page.evaluate(() => window.uiStateHarness.writes.map(write => ({ owner: write.ownerId, signature: write.payload.signature }))))
  71  |     .toEqual([{ owner: A, signature: 'OLD-SAVE-A' }, { owner: A, signature: 'CURRENT-DRAFT-A' }]);
  72  | });
  73  | 
  74  | test('email settings: A-B-A ignores an old disconnect receipt and keeps the new connection', async ({ page }) => {
  75  |   await page.goto('/tests/ui-state/index.html?page=email');
  76  |   await waitConfig(page, A); await resolveConfig(page, A, 'FIRST-A', true);
  77  |   await page.evaluate(() => { window.uiStateHarness.deferWrites = true; });
  78  |   page.on('dialog', dialog => dialog.accept());
  79  |   await page.getByRole('button', { name: 'Déconnecter', exact: true }).click(); await waitWrites(page, 1);
  80  |   await switchAndLoad(page, B, 'PRIVATE-B', true);
  81  |   await switchAndLoad(page, A, 'CURRENT-A', true);
  82  |   await expect(page.getByText('current-a@fixture.invalid', { exact: true })).toBeVisible();
  83  | 
  84  |   await page.evaluate(() => window.uiStateHarness.resolveWrite(0)); await settle(page);
> 85  |   await expect(page.getByText('Gmail déconnecté', { exact: true })).toHaveCount(0);
      |                                                                     ^ Error: expect(locator).toHaveCount(expected) failed
  86  |   await expect(page.locator(signature)).toHaveValue('CURRENT-A');
  87  |   await expect(page.getByText('current-a@fixture.invalid', { exact: true })).toBeVisible();
  88  |   await page.getByRole('button', { name: 'Déconnecter', exact: true }).click(); await waitWrites(page, 2);
  89  |   await page.evaluate(() => window.uiStateHarness.resolveWrite(1));
  90  |   await expect(page.getByText('Gmail déconnecté', { exact: true })).toBeVisible();
  91  |   await expect(page.getByRole('button', { name: 'Connecter un compte Gmail', exact: true })).toBeVisible();
  92  | });
  93  | 
  94  | test('email dashboard: a rejected initial A load cannot notify the newer A lifetime', async ({ page }) => {
  95  |   await page.goto('/tests/ui-state/index.html?page=emailDashboard');
  96  |   await waitConfig(page, A);
  97  |   await switchAndLoad(page, B, 'PRIVATE-B', true);
  98  |   await expect(page.getByText('private-b@fixture.invalid', { exact: true })).toBeVisible();
  99  |   await page.evaluate(owner => window.uiStateHarness.setIdentity(owner), A);
  100 |   await waitConfig(page, A, 2); await resolveConfig(page, A, 'CURRENT-A', true, true);
  101 |   await expect(page.getByText('current-a@fixture.invalid', { exact: true })).toBeVisible();
  102 | 
  103 |   await page.evaluate(owner => window.uiStateHarness.rejectConfig('email_agent_config', owner), A); await settle(page);
  104 |   await expect(page.getByText('Erreur de chargement', { exact: true })).toHaveCount(0);
  105 |   await expect(page.getByText('current-a@fixture.invalid', { exact: true })).toBeVisible();
  106 | });
  107 | 
  108 | test('email dashboard: an old rejected activation cannot notify a later account lifetime', async ({ page }) => {
  109 |   await page.goto('/tests/ui-state/index.html?page=emailDashboard');
  110 |   await waitConfig(page, A); await resolveConfig(page, A, 'FIRST-A', true);
  111 |   await page.evaluate(() => { window.uiStateHarness.deferWrites = true; });
  112 |   await page.getByRole('switch').click(); await waitWrites(page, 1);
  113 |   await switchAndLoad(page, B, 'PRIVATE-B', true);
  114 |   await switchAndLoad(page, A, 'CURRENT-A', true);
  115 |   await expect(page.getByText('current-a@fixture.invalid', { exact: true })).toBeVisible();
  116 |   await page.evaluate(() => window.uiStateHarness.resolveWrite(0, true)); await settle(page);
  117 |   await expect(page.getByText('Impossible de mettre à jour', { exact: true })).toHaveCount(0);
  118 |   await expect(page.getByRole('switch')).toBeEnabled();
  119 | 
  120 |   await page.getByRole('switch').click(); await waitWrites(page, 2);
  121 |   await page.evaluate(() => window.uiStateHarness.resolveWrite(1));
  122 |   await expect(page.getByText('🤖 Agent activé', { exact: true })).toBeVisible();
  123 |   await expect(page.getByRole('switch')).toBeChecked();
  124 | });
  125 | 
```