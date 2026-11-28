# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: email-lifecycle.spec.ts >> email dashboard: a rejected initial A load cannot notify the newer A lifetime
- Location: tests/ui-state/email-lifecycle.spec.ts:94:1

# Error details

```
Error: expect(locator).toHaveCount(expected) failed

Locator:  getByText('Erreur de chargement', { exact: true })
Expected: 0
Received: 1
Timeout:  1500ms

Call log:
  - Expect "toHaveCount" with timeout 1500ms
  - waiting for getByText('Erreur de chargement', { exact: true })
    5 × locator resolved to 1 element
      - unexpected value "1"

```

# Page snapshot

```yaml
- generic [ref=e2]:
  - generic [ref=e3]:
    - generic [ref=e4]:
      - generic [ref=e5]:
        - heading "Agent Email En pause" [level=1] [ref=e6]:
          - img [ref=e7]
          - text: Agent Email
          - generic [ref=e10]: En pause
        - paragraph [ref=e11]: Ton agent IA qui lit, trie et répond à tes emails en continu.
      - link "Réglages" [ref=e13] [cursor=pointer]:
        - /url: /dashboard/email-agent/settings
        - button "Réglages" [ref=e14]:
          - img
          - text: Réglages
    - generic [ref=e16]:
      - generic [ref=e17]:
        - img [ref=e18]
        - generic [ref=e21]:
          - paragraph [ref=e22]: current-a@fixture.invalid
          - paragraph [ref=e23]: En attente du premier scan…
      - link "Gérer" [ref=e24] [cursor=pointer]:
        - /url: /dashboard/email-agent/settings
        - button "Gérer" [ref=e25]
    - generic [ref=e27]:
      - generic [ref=e28]:
        - generic [ref=e29]:
          - img [ref=e31]
          - generic [ref=e33]:
            - paragraph [ref=e34]: Activer l'agent
            - paragraph [ref=e35]: L'agent traite tes nouveaux emails toutes les 2 minutes.
        - switch [ref=e36] [cursor=pointer]
      - generic [ref=e37]:
        - generic [ref=e38]:
          - generic [ref=e39]:
            - paragraph [ref=e40]:
              - img [ref=e41]
              - text: Niveau d'autonomie
            - paragraph [ref=e51]: Choisis combien tu laisses l'agent décider seul.
          - generic [ref=e52]: Niveau 2 — Trieur
        - slider [ref=e57]
        - generic [ref=e58]:
          - generic [ref=e59]: 👀
          - generic [ref=e60]: 🗂️
          - generic [ref=e61]: 🤝
          - generic [ref=e62]: 🚀
          - generic [ref=e63]: 🤖
        - generic [ref=e64]:
          - generic [ref=e65]: 🗂️ Trieur.
          - text: Classe + notifie les emails importants.
    - generic [ref=e66]:
      - generic [ref=e69]:
        - img [ref=e71]
        - paragraph [ref=e74]: "0"
        - paragraph [ref=e75]: Traités
      - generic [ref=e78]:
        - img [ref=e80]
        - paragraph [ref=e82]: "0"
        - paragraph [ref=e83]: Réponses auto
      - generic [ref=e86]:
        - img [ref=e88]
        - paragraph [ref=e91]: "0"
        - paragraph [ref=e92]: Brouillons
      - generic [ref=e95]:
        - img [ref=e97]
        - paragraph [ref=e100]: 0h
        - paragraph [ref=e101]: Temps gagné
    - generic [ref=e102]:
      - link "Activité" [ref=e103] [cursor=pointer]:
        - /url: /dashboard/email-agent/logs
        - generic [ref=e105]:
          - img [ref=e107]
          - paragraph [ref=e110]: Activité
      - link "Règles" [ref=e111] [cursor=pointer]:
        - /url: /dashboard/email-agent/rules
        - generic [ref=e113]:
          - img [ref=e115]
          - paragraph [ref=e118]: Règles
      - link "Contacts" [ref=e119] [cursor=pointer]:
        - /url: /dashboard/email-agent/memory
        - generic [ref=e121]:
          - img [ref=e123]
          - paragraph [ref=e129]: Contacts
      - link "Templates" [ref=e130] [cursor=pointer]:
        - /url: /dashboard/email-agent/templates
        - generic [ref=e132]:
          - img [ref=e134]
          - paragraph [ref=e137]: Templates
    - generic [ref=e138]:
      - generic [ref=e139]:
        - generic [ref=e140]:
          - generic [ref=e141]: 📬
          - generic [ref=e142]:
            - paragraph [ref=e143]: Chat avec Agent Email
            - paragraph [ref=e144]: Texte ou voix · contexte gardé
        - generic [ref=e145]:
          - button "Mode vocal" [ref=e146] [cursor=pointer]:
            - img
            - text: Mode vocal
          - button "Nouvelle" [ref=e147] [cursor=pointer]:
            - img
            - text: Nouvelle
      - generic [ref=e150]:
        - img [ref=e151]
        - paragraph [ref=e154]: Démarre une conversation avec Agent Email
        - paragraph [ref=e155]: Tape ou utilise le micro · Agent Email répond comme un expert.
        - generic [ref=e156]:
          - button "Rédige un email de relance pour une facture impayée" [ref=e157] [cursor=pointer]:
            - img [ref=e158]
            - text: Rédige un email de relance pour une facture impayée
          - button "Comment trier mes emails plus efficacement ?" [ref=e160] [cursor=pointer]:
            - img [ref=e161]
            - text: Comment trier mes emails plus efficacement ?
          - button "Crée un template de prospection commerciale" [ref=e163] [cursor=pointer]:
            - img [ref=e164]
            - text: Crée un template de prospection commerciale
          - button "Analyse le ton de mes derniers échanges clients" [ref=e166] [cursor=pointer]:
            - img [ref=e167]
            - text: Analyse le ton de mes derniers échanges clients
      - generic [ref=e170]:
        - button "Dicter un message" [ref=e171] [cursor=pointer]:
          - img
        - textbox "Parle à Agent Email…" [ref=e172]
        - button [disabled]:
          - img
    - generic [ref=e174]:
      - generic [ref=e175]:
        - heading "Activité récente" [level=2] [ref=e176]
        - link "Tout voir" [ref=e177] [cursor=pointer]:
          - /url: /dashboard/email-agent/logs
          - text: Tout voir
          - img [ref=e178]
      - generic [ref=e180]: L'agent est en pause. Active-le pour qu'il commence à traiter tes emails.
  - region "Notifications alt+T":
    - list:
      - listitem [ref=e181]:
        - img [ref=e183]
        - generic [ref=e185]:
          - generic [ref=e186]: Erreur de chargement
          - generic [ref=e187]: "[object Object]"
```

# Test source

```ts
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
  85  |   await expect(page.getByText('Gmail déconnecté', { exact: true })).toHaveCount(0);
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
> 104 |   await expect(page.getByText('Erreur de chargement', { exact: true })).toHaveCount(0);
      |                                                                         ^ Error: expect(locator).toHaveCount(expected) failed
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