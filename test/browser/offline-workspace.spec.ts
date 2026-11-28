import { test as base, expect, type Page, type BrowserContext } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The real public assets and service worker run on an isolated loopback origin.
// No application API, account, cloud response, or successful storage is mocked.
const publicDirectory = fileURLToPath(new URL('../../public/', import.meta.url));
const databaseName = 'purama-offline-workspace';
const unavailableAssets = new Set<string>();
const contentOverrides = new Map<string, { body: string; contentType: string }>();
let dropNetwork = false;
let droppedConnections = 0;
let server: Server;
let origin: string;

interface StoredText {
  id: string;
  kind: 'draft' | 'document';
  title: string;
  body: string;
  revision: number;
}

type StorageTestWindow = typeof window & {
  __failedTextWrite: { failed: boolean; refreshed: boolean };
  __heldTextWrite: {
    putSucceeded: boolean;
    completed: number;
    aborted: number;
    finish: 'commit' | 'abort' | null;
  };
};

const test = base.extend<{ networkAudit: (context: BrowserContext) => void }>({
  networkAudit: [async ({ context }, use, testInfo) => {
    const forbiddenRequests: string[] = [];
    const observedRequests = new Set<string>();
    const isForbidden = (address: string) => {
      const url = new URL(address);
      return /^https?:$/.test(url.protocol)
        && (url.origin !== origin || /^\/(api|functions)(\/|$)/.test(url.pathname));
    };
    const observe = (watchedContext: BrowserContext) => {
      watchedContext.on('request', (request) => {
        observedRequests.add(`${request.method()} ${request.url()}`);
        if (isForbidden(request.url())) {
          forbiddenRequests.push(`${request.method()} ${request.url()}`);
        }
      });
      watchedContext.on('page', (page) => {
        page.on('websocket', (socket) => forbiddenRequests.push(`WEBSOCKET ${socket.url()}`));
      });
    };
    observe(context);
    // Do not intercept permitted requests: route.continue can change offline
    // emulation for service-worker fetches. CSP and the launch DNS policy stay active.
    await use(observe);
    await testInfo.attach('network-audit.json', {
      body: Buffer.from(JSON.stringify({ observedRequests: [...observedRequests], forbiddenRequests }, null, 2)),
      contentType: 'application/json',
    });
    expect(forbiddenRequests, 'The offline workspace must not call an application API or external service').toEqual([]);
  }, { auto: true }],
});

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    if (dropNetwork) {
      droppedConnections += 1;
      request.socket.destroy();
      return;
    }
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (unavailableAssets.has(pathname)) {
        response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Asset deliberately unavailable during preparation test');
        return;
      }
      const override = contentOverrides.get(pathname);
      if (override) {
        response.writeHead(200, {
          'Content-Type': override.contentType,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(override.body);
        return;
      }
      const asset = resolve(publicDirectory, `.${decodeURIComponent(pathname === '/' ? '/offline.html' : pathname)}`);
      if (!asset.startsWith(`${publicDirectory.replace(/\/$/, '')}${sep}`)) {
        response.writeHead(403);
        response.end();
        return;
      }
      const content = await readFile(asset);
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
      };
      response.writeHead(200, {
        'Content-Type': types[extname(asset)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Service-Worker-Allowed': '/',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(content);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  });
  await new Promise<void>((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveReady);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback test server did not bind');
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterEach(() => {
  unavailableAssets.clear();
  contentOverrides.clear();
  dropNetwork = false;
  droppedConnections = 0;
});
test.afterAll(async () => {
  if (!server?.listening) return;
  await new Promise<void>((resolveClosed, reject) => {
    server.close((error) => error ? reject(error) : resolveClosed());
    server.closeAllConnections();
  });
});

async function openWorkspace(page: Page) {
  await page.goto(`${origin}/offline.html`);
  await expect(page.locator('#storage-status')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByText('La génération IA n’est pas disponible dans cet espace.', { exact: true })).toBeVisible();
}

async function prepareOffline(page: Page) {
  if (await page.locator('#preparation-status').getAttribute('data-state') !== 'ready') {
    await page.locator('#prepare-offline').click();
  }
  await expect(page.locator('#preparation-status')).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  const cachedAssets = await page.evaluate(async () => {
    const cache = await caches.open('purama-offline-v10');
    return Promise.all(['/offline.html', '/offline-workspace.js', '/offline-library-backup.js', '/manifest.json'].map(async (path) => Boolean(await cache.match(path))));
  });
  expect(cachedAssets).toEqual([true, true, true, true]);
}

async function storedTexts(page: Page): Promise<StoredText[]> {
  return page.evaluate((name) => new Promise<StoredText[]>((resolveRecords, reject) => {
    const request = indexedDB.open(name);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('texts', 'readonly');
      const all = transaction.objectStore('texts').getAll();
      transaction.oncomplete = () => {
        database.close();
        resolveRecords(all.result);
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error);
      };
    };
  }), databaseName);
}

async function saveDraft(page: Page, title: string, body: string) {
  await page.locator('#document-title').fill(title);
  await page.locator('#document-body').fill(body);
  await page.locator('#save-document').click();
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved');
}

async function openRecord(page: Page, id: string) {
  await page.locator(`#document-list button[data-record-id="${id}"]`).click();
}

async function fillUncommittedDraft(page: Page, draft: { title?: string; body: string }) {
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put;
    const originalGetAll = IDBObjectStore.prototype.getAll;
    const audit = { failed: false, refreshed: false };
    (window as StorageTestWindow).__failedTextWrite = audit;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name !== 'texts' || this.transaction.db.name !== 'purama-offline-workspace') {
        return originalPut.apply(this, args);
      }
      // A real attempted autosave fails once; the product must retain its dirty
      // editor and pause retries. Later archive writes use the original API.
      IDBObjectStore.prototype.put = originalPut;
      audit.failed = true;
      throw new DOMException('One text write exceeds quota for this test', 'QuotaExceededError');
    };
    IDBObjectStore.prototype.getAll = function (...args: Parameters<IDBObjectStore['getAll']>) {
      const request = originalGetAll.apply(this, args);
      if (audit.failed && this.name === 'texts' && this.transaction.db.name === 'purama-offline-workspace') {
        IDBObjectStore.prototype.getAll = originalGetAll;
        this.transaction.addEventListener('complete', () => { audit.refreshed = true; }, { once: true });
      }
      return request;
    };
  });
  if (draft.title !== undefined) await page.locator('#document-title').fill(draft.title);
  await page.locator('#document-body').fill(draft.body);
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'error');
  // Drain the actual failure-triggered refresh before another tab changes storage.
  // Otherwise its deferred read could pre-empt a test of a specific stale action.
  await expect.poll(() => page.evaluate(() => (window as StorageTestWindow).__failedTextWrite))
    .toEqual({ failed: true, refreshed: true });
}

async function holdNextTextWrite(page: Page) {
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put;
    const audit: StorageTestWindow['__heldTextWrite'] = {
      putSucceeded: false, completed: 0, aborted: 0, finish: null,
    };
    (window as StorageTestWindow).__heldTextWrite = audit;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name !== 'texts' || this.transaction.db.name !== 'purama-offline-workspace') {
        return originalPut.apply(this, args);
      }
      IDBObjectStore.prototype.put = originalPut;
      const transaction = this.transaction;
      transaction.addEventListener('complete', () => { audit.completed += 1; });
      transaction.addEventListener('abort', () => { audit.aborted += 1; });
      const request = originalPut.apply(this, args);
      request.addEventListener('success', () => {
        audit.putSucceeded = true;
        // Keep the real IndexedDB transaction open with real reads. A successful
        // put request is deliberately separated from its durable commit.
        const keepPending = () => {
          if (audit.finish === 'abort') { transaction.abort(); return; }
          if (audit.finish === 'commit') return;
          this.get((args[0] as StoredText).id).addEventListener('success', keepPending);
        };
        keepPending();
      });
      return request;
    };
  });
}

test('autosave: retains offline typing and reopens the committed document without a save click', async ({ page, context }) => {
  await openWorkspace(page);
  await prepareOffline(page);
  await context.setOffline(true);
  dropNetwork = true;
  await page.locator('#document-title').fill('Création en mode avion');
  await page.locator('#document-body').fill('Mon texte et sa mémoire locale restent disponibles.');
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved');
  const [original] = await storedTexts(page);
  expect(original.body).toBe('Mon texte et sa mémoire locale restent disponibles.');
  await page.locator('#document-body').fill('Mon texte corrigé après la première sauvegarde.');
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved');
  const rows = await storedTexts(page);
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(original.id);
  expect(rows[0].body).toBe('Mon texte corrigé après la première sauvegarde.');
  expect(rows[0].revision).toBe(original.revision + 1);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(`${origin}/offline.html`);
  await expect(reopened.locator('#document-title')).toHaveValue('Création en mode avion');
  await expect(reopened.locator('#document-body')).toHaveValue('Mon texte corrigé après la première sauvegarde.');
  expect(await storedTexts(reopened)).toEqual(rows);

  dropNetwork = false;
  await context.setOffline(false);
  await reopened.reload();
  await expect(reopened.locator('#document-body')).toHaveValue(rows[0].body);
  expect(await storedTexts(reopened), 'Reconnection must keep the same local record without duplication').toEqual(rows);
  await reopened.locator('#document-body').fill('Suite du même texte après le retour de la connexion.');
  await expect(reopened.locator('#save-status')).toHaveAttribute('data-state', 'saved');
  expect(await storedTexts(reopened)).toEqual([
    expect.objectContaining({ id: original.id, body: 'Suite du même texte après le retour de la connexion.', revision: rows[0].revision + 1 }),
  ]);
});

test('autosave: keeps typing and the caret intact while a real write waits for commit', async ({ page }) => {
  await openWorkspace(page);
  await saveDraft(page, 'Texte en cours', 'Dernière version durable.');
  const [original] = await storedTexts(page);
  await holdNextTextWrite(page);
  await page.locator('#document-body').fill('Première version dans la transaction retenue.');
  await expect.poll(() => page.evaluate(() => (window as StorageTestWindow).__heldTextWrite.putSucceeded)).toBe(true);
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saving');
  await expect(page.locator('#document-title')).toBeEnabled();
  await expect(page.locator('#document-body')).toBeEnabled();
  await expect(page.locator('#save-document')).toBeDisabled();
  await expect(page.locator('#new-draft')).toBeDisabled();
  const latest = 'Texte saisi pendant la transaction, sans perte de caractères. 🧭';
  await page.locator('#document-body').fill(latest);
  await page.locator('#document-body').evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(12, 12));
  await expect(page.locator('#save-status')).not.toHaveAttribute('data-state', 'saved');
  expect(await page.evaluate(() => (window as StorageTestWindow).__heldTextWrite))
    .toEqual({ putSucceeded: true, completed: 0, aborted: 0, finish: null });
  await page.evaluate(() => { (window as StorageTestWindow).__heldTextWrite.finish = 'commit'; });
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved');
  await expect(page.locator('#document-body')).toHaveValue(latest);
  expect(await page.locator('#document-body').evaluate((field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd]))
    .toEqual([12, 12]);
  // Two distinct snapshots really commit: the held write, then the queued edit.
  expect(await storedTexts(page)).toEqual([
    expect.objectContaining({ id: original.id, title: original.title, body: latest, revision: original.revision + 2 }),
  ]);
  expect(await page.evaluate(() => (window as StorageTestWindow).__heldTextWrite))
    .toEqual({ putSucceeded: true, completed: 1, aborted: 0, finish: 'commit' });
});

test('autosave: an aborted successful put retains the last commit and retries only on explicit save', async ({ page }) => {
  await openWorkspace(page);
  await saveDraft(page, 'Version fiable', 'Texte réellement committé.');
  const before = await storedTexts(page);
  await holdNextTextWrite(page);
  await page.locator('#document-body').fill('Texte dont la requête réussit avant annulation.');
  await expect.poll(() => page.evaluate(() => (window as StorageTestWindow).__heldTextWrite.putSucceeded)).toBe(true);
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saving');
  await page.evaluate(() => { (window as StorageTestWindow).__heldTextWrite.finish = 'abort'; });
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'error');
  expect(await storedTexts(page)).toEqual(before);
  expect(await page.evaluate(() => (window as StorageTestWindow).__heldTextWrite))
    .toEqual({ putSucceeded: true, completed: 0, aborted: 1, finish: 'abort' });
  const latest = 'Nouvelle saisie conservée après l’échec, avant réessai explicite.';
  await page.locator('#document-body').fill(latest);
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'error');
  expect(await storedTexts(page), 'Typing after the failure must not silently retry a paused autosave').toEqual(before);
  await page.locator('#save-document').click();
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved');
  expect(await storedTexts(page)).toEqual([
    expect.objectContaining({ id: before[0].id, body: latest, revision: before[0].revision + 1 }),
  ]);
});

test('prepares the real service worker, then reloads and persists an edited draft offline', async ({ page, context }, testInfo) => {
  await openWorkspace(page);
  await prepareOffline(page);
  // A still-active SW is insufficient if the browser has evicted its cached assets.
  await page.evaluate(() => caches.delete('purama-offline-v10'));
  await page.reload();
  await expect(page.locator('#storage-status')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#preparation-status')).toHaveAttribute('data-state', 'missing');
  await prepareOffline(page);
  await saveDraft(page, 'Carnet de terrain', 'Premier brouillon enregistré dans IndexedDB.');
  const [original] = await storedTexts(page);
  expect(original).toMatchObject({ kind: 'draft', title: 'Carnet de terrain' });
  expect(original.revision).toBeGreaterThanOrEqual(1);
  expect(original.revision).toBeLessThanOrEqual(2);

  await context.setOffline(true);
  // Close actual transport too: some Chromium versions keep SW fetches online
  // despite page-level emulation. No synthetic response or fallback is supplied.
  dropNetwork = true;
  await page.reload();
  await expect(page.locator('#storage-status')).toHaveAttribute('data-state', 'ready');
  await openRecord(page, original.id);
  await expect(page.locator('#document-body')).toHaveValue(original.body);
  await saveDraft(page, original.title, 'Modification réellement sauvegardée sans Internet.');

  // This navigation has never been cached. The real SW must provide its fallback.
  const fallback = await page.goto(`${origin}/offline-proof-uncached-route`);
  expect(fallback?.fromServiceWorker()).toBe(true);
  expect(fallback?.status()).toBe(200);
  await expect(page.locator('#storage-status')).toHaveAttribute('data-state', 'ready');
  await openRecord(page, original.id);
  await expect(page.locator('#document-body')).toHaveValue('Modification réellement sauvegardée sans Internet.');
  expect(await storedTexts(page)).toEqual([
    expect.objectContaining({ id: original.id, body: 'Modification réellement sauvegardée sans Internet.', revision: original.revision + 1 }),
  ]);
  await expect(page.getByRole('button', { name: /générer|demander.*IA|envoyer.*IA/i })).toHaveCount(0);
  await testInfo.attach('offline-transport-proof.json', {
    body: Buffer.from(JSON.stringify({ offlineEmulation: true, serverDropsConnections: dropNetwork, droppedConnections, fromServiceWorker: fallback?.fromServiceWorker(), responseStatus: fallback?.status() }, null, 2)),
    contentType: 'application/json',
  });
  await page.screenshot({ path: testInfo.outputPath('offline-desktop.png'), fullPage: true });
});

test('imports and searches real text safely at 390px without horizontal overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page);
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /connect-src 'none'/);
  const maliciousText = [
    'Repère-azur : texte local à retrouver.',
    '<img src="https://outside.invalid/should-not-load.png" onerror="window.__unsafeExecuted=true">',
    '<script>window.__unsafeExecuted=true</script>',
    '<a href="https://outside.invalid/">ne pas interpréter</a>',
    'L'.repeat(500),
  ].join('\n');
  await page.locator('#import-file').setInputFiles({
    name: 'Notes-<img onerror=alert(1)>.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(maliciousText),
  });
  await expect.poll(async () => (await storedTexts(page)).length).toBe(1);
  const [imported] = await storedTexts(page);
  expect(imported).toMatchObject({ kind: 'document', body: maliciousText });
  await page.locator('#search-input').fill('repère-azur');
  await expect(page.locator('#document-list button[data-record-id]')).toHaveCount(1);
  await openRecord(page, imported.id);
  await expect(page.locator('#document-body')).toHaveValue(maliciousText);
  await expect(page.locator('#document-list img, #document-list script, #document-list a')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__unsafeExecuted)).toBeUndefined();

  await page.locator('#search-input').fill('ce terme ne figure dans aucun document');
  await expect(page.locator('#document-list button[data-record-id]')).toHaveCount(0);
  await page.locator('#search-input').fill('');
  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.width);
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.width);
  await page.screenshot({ path: testInfo.outputPath('offline-mobile-390.png'), fullPage: true });

  const oversizedText = 'é'.repeat(524_289); // 1 MiB + 2 bytes in UTF-8.
  await page.locator('#import-file').setInputFiles({ name: 'trop-grand.txt', mimeType: 'text/plain', buffer: Buffer.from(oversizedText) });
  await expect(page.locator('#error-message')).toContainText('dépasse la limite de 1 Mio');
  await expect(page.locator('#document-body')).toHaveValue(maliciousText);
  await page.locator('#document-body').fill(oversizedText);
  await page.locator('#save-document').click();
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'error');
  expect(await page.locator('#document-body').inputValue()).toBe(oversizedText);
  expect((await storedTexts(page)).find((item) => item.id === imported.id)?.body).toBe(maliciousText);
});

test('preserves both conflicting versions across two tabs and never resurrects a deleted note', async ({ page, context }, testInfo) => {
  // CAS must protect data even when cross-tab broadcasts are unavailable.
  await context.addInitScript(() => { Reflect.deleteProperty(window, 'BroadcastChannel'); });
  await openWorkspace(page);
  await saveDraft(page, 'Note partagée entre onglets', 'Version initiale');
  const [original] = await storedTexts(page);
  const other = await context.newPage();
  await openWorkspace(other);
  await openRecord(other, original.id);

  await fillUncommittedDraft(other, { body: 'Version du second onglet à conserver' });
  await page.locator('#document-body').fill('Version du premier onglet');
  await page.locator('#save-document').click();
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved');
  // A DOM click does not move focus and therefore does not trigger a refresh first.
  // The real handler and IndexedDB transaction still perform the stale write check.
  if (await other.locator('#save-status').getAttribute('data-state') !== 'conflict') {
    await other.locator('#save-document').evaluate((button: HTMLButtonElement) => button.click());
  }
  await expect(other.locator('#save-status')).toHaveAttribute('data-state', 'conflict');
  await expect(other.locator('#save-document')).toBeDisabled();
  await expect(other.locator('#document-body')).toHaveValue('Version du second onglet à conserver');
  expect((await storedTexts(page)).find((item) => item.id === original.id)?.body).toBe('Version du premier onglet');
  await other.locator('#save-copy').click();
  await expect(other.locator('#save-status')).toHaveAttribute('data-state', 'saved');
  const both = await storedTexts(page);
  expect(both.map((item) => item.body).sort()).toEqual(['Version du premier onglet', 'Version du second onglet à conserver'].sort());
  const copy = both.find((item) => item.id !== original.id)!;
  await other.screenshot({ path: testInfo.outputPath('offline-desktop-conflict-resolved.png'), fullPage: true });

  await other.locator('#refresh-library').click();
  await openRecord(other, original.id);
  await fillUncommittedDraft(other, { body: 'Édition devenue périmée après suppression' });
  page.once('dialog', (dialog) => void dialog.accept());
  await page.locator('#delete-document').click();
  await expect.poll(async () => (await storedTexts(page)).map((item) => item.id)).toEqual([copy.id]);
  if (await other.locator('#save-status').getAttribute('data-state') !== 'conflict') {
    await other.locator('#save-document').evaluate((button: HTMLButtonElement) => button.click());
  }
  await expect(other.locator('#save-status')).toHaveAttribute('data-state', 'conflict');
  await expect(other.locator('#save-document')).toBeDisabled();
  await expect(other.locator('#document-body')).toHaveValue('Édition devenue périmée après suppression');
  expect((await storedTexts(page)).map((item) => item.id)).toEqual([copy.id]);

  await page.locator('#refresh-library').click();
  await openRecord(page, copy.id);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.locator('#delete-document').click();
  await expect.poll(async () => (await storedTexts(page)).length).toBe(0);
  await page.reload();
  await expect(page.locator('#storage-status')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#document-list button[data-record-id]')).toHaveCount(0);
});

test('reports denied browser storage without claiming a draft was saved', async ({ page, context }) => {
  // Fault injection tests an actual browser API failure, not successful fake storage.
  await context.addInitScript(() => {
    Object.defineProperty(IDBFactory.prototype, 'open', {
      configurable: true,
      value() { throw new DOMException('Storage denied for this test', 'SecurityError'); },
    });
  });
  await page.goto(`${origin}/offline.html`);
  await expect(page.locator('#storage-status')).toHaveAttribute('data-state', 'error');
  await page.locator('#document-title').fill('À conserver manuellement');
  await page.locator('#document-body').fill('Texte non enregistré faute de stockage.');
  if (await page.locator('#save-document').isEnabled()) await page.locator('#save-document').click();
  await expect(page.locator('#save-status')).not.toHaveAttribute('data-state', 'saved');
  await expect(page.locator('#document-body')).toHaveValue('Texte non enregistré faute de stockage.');
});

test('reports a quota write failure and retains the last committed IndexedDB version', async ({ page }) => {
  await openWorkspace(page);
  await saveDraft(page, 'Dernière version fiable', 'Contenu effectivement enregistré');
  const [original] = await storedTexts(page);
  await page.evaluate(() => {
    // A physical disk-full condition is not claimed: inject the browser's named error.
    for (const method of ['put', 'add'] as const) {
      const originalWrite = IDBObjectStore.prototype[method];
      Object.defineProperty(IDBObjectStore.prototype, method, {
        configurable: true,
        writable: true,
        value(this: IDBObjectStore, ...args: [unknown, IDBValidKey?]) {
          if (this.name === 'texts') throw new DOMException('Storage full for this test', 'QuotaExceededError');
          return originalWrite.apply(this, args);
        },
      });
    }
  });
  await page.locator('#document-body').fill('Modification qui ne tient plus dans le stockage');
  await page.locator('#save-document').click();
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#document-body')).toHaveValue('Modification qui ne tient plus dans le stockage');
  expect((await storedTexts(page)).find((item) => item.id === original.id)?.body).toBe(original.body);
  let sawBeforeUnload = false;
  page.once('dialog', (dialog) => {
    sawBeforeUnload = dialog.type() === 'beforeunload';
    void dialog.accept();
  });
  await page.reload();
  expect(sawBeforeUnload, 'Unsaved changes must trigger the browser navigation warning').toBe(true);
  await expect(page.locator('#storage-status')).toHaveAttribute('data-state', 'ready');
  await openRecord(page, original.id);
  await expect(page.locator('#document-body')).toHaveValue(original.body);
});

test('does not announce offline readiness when a required service-worker asset is unavailable', async ({ page }) => {
  await openWorkspace(page);
  unavailableAssets.add('/offline-workspace.js');
  await page.locator('#prepare-offline').click();
  await expect(page.locator('#preparation-status')).toHaveAttribute('data-state', /^(error|missing)$/, { timeout: 15_000 });
  await expect(page.locator('#preparation-status')).not.toHaveAttribute('data-state', 'ready');
});


async function cacheSnapshot(page: Page) {
  return page.evaluate(async () => {
    const cache = await caches.open('purama-offline-v10');
    return Promise.all(['/offline.html', '/offline-workspace.js', '/offline-library-backup.js', '/manifest.json'].map(async (path) => {
      const response = await cache.match(path);
      return response ? {
        path,
        status: response.status,
        contentType: response.headers.get('content-type'),
        body: await response.text(),
      } : { path, absent: true };
    }));
  });
}

async function requestRepreparation(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const worker = registration?.active;
    if (!worker || worker.state !== 'activated') throw new Error('Expected an already prepared active worker');
    return new Promise<{ type: string; ready: boolean; version: string; refreshed: boolean }>((resolveStatus, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        channel.port1.close();
        reject(new Error('Offline preparation did not return its status'));
      }, 12_000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        channel.port1.close();
        resolveStatus(event.data);
      };
      worker.postMessage({ type: 'PURAMA_OFFLINE_PREPARE' }, [channel.port2]);
    });
  });
}

test('rejects an HTTP 200 HTML fallback returned in place of the required script', async ({ page }) => {
  // Load the functioning editor first; only the subsequent preparation receives the faulty resource.
  await openWorkspace(page);
  contentOverrides.set('/offline-workspace.js', {
    body: '<!doctype html><html><body>Fallback SPA au lieu du script requis</body></html>',
    contentType: 'text/html; charset=utf-8',
  });
  await page.locator('#prepare-offline').click();
  await expect(page.locator('#preparation-status')).toHaveAttribute('data-state', /^(error|missing)$/, { timeout: 20_000 });
  await expect(page.locator('#preparation-status')).not.toHaveAttribute('data-state', 'ready');
  const snapshot = await cacheSnapshot(page);
  expect(snapshot.some((entry) => 'body' in entry && entry.body?.includes('Fallback SPA au lieu du script requis'))).toBe(false);
});

test('rejects a bad HTTP 200 repair without replacing the last usable offline workspace', async ({ page, context }) => {
  await openWorkspace(page);
  await prepareOffline(page);
  await saveDraft(page, 'Version à conserver', 'Les fichiers préparés restent utilisables.');
  const [original] = await storedTexts(page);
  const before = await cacheSnapshot(page);
  contentOverrides.set('/offline-workspace.js', {
    body: '<!doctype html><html><body>Réponse HTTP 200 incorrecte</body></html>',
    contentType: 'text/html; charset=utf-8',
  });
  const result = await requestRepreparation(page);
  expect(result).toMatchObject({
    type: 'PURAMA_OFFLINE_STATUS',
    version: 'purama-offline-v10',
    ready: true,
    refreshed: false,
  });
  expect(await cacheSnapshot(page)).toEqual(before);

  // A failed refresh may still report ready when the previous, verified assets survive.
  dropNetwork = true;
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#storage-status')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#preparation-status')).toHaveAttribute('data-state', 'ready');
  await openRecord(page, original.id);
  await expect(page.locator('#document-body')).toHaveValue(original.body);
});

test('rejects modified JavaScript even when its HTTP status and MIME type are valid', async ({ page }) => {
  await openWorkspace(page);
  const script = await readFile(resolve(publicDirectory, 'offline-workspace.js'), 'utf8');
  // Valid JavaScript with identical runtime behavior, but not the bytes of this release.
  contentOverrides.set('/offline-workspace.js', {
    body: `${script}\n// Unexpected content from a different release\n`,
    contentType: 'text/javascript; charset=utf-8',
  });
  await page.locator('#prepare-offline').click();
  await expect(page.locator('#preparation-status')).toHaveAttribute('data-state', /^(error|missing)$/, { timeout: 20_000 });
  await expect(page.locator('#preparation-status')).not.toHaveAttribute('data-state', 'ready');
  const snapshot = await cacheSnapshot(page);
  expect(snapshot.some((entry) => 'body' in entry && entry.body?.includes('Unexpected content from a different release'))).toBe(false);
});

test('exports unsaved text as a real download and restores it offline in a separately prepared profile', async ({ page, context, browser, networkAudit }) => {
  await openWorkspace(page);
  await prepareOffline(page);
  await saveDraft(page, 'Journal enregistré', 'Dernière version enregistrée avant les modifications.');
  const [saved] = await storedTexts(page);
  const unsavedText = 'Texte modifié sans enregistrement.\n\nGenève → Frasne : été, forêt, français. 🧭\n<script>reste du texte brut</script>\nTabulation\tconservée.\n';
  await fillUncommittedDraft(page, { title: 'Voyage : Genève / Frasne ?', body: unsavedText });
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'error');

  const downloaded = page.waitForEvent('download');
  await page.locator('#export-document').click();
  const download = await downloaded;
  expect(await download.failure()).toBeNull();
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error('Browser did not expose the completed local download');
  const downloadedBytes = await readFile(downloadPath);
  expect(downloadedBytes).toEqual(Buffer.from(unsavedText, 'utf8'));
  expect(download.suggestedFilename()).toMatch(/\.txt$/);
  expect(download.suggestedFilename()).not.toMatch(/[<>:"/\\|?*]/);
  expect([...download.suggestedFilename()].every((character) => character.charCodeAt(0) >= 32)).toBe(true);
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'error');
  expect((await storedTexts(page)).find((record) => record.id === saved.id)?.body).toBe(saved.body);

  const restoredContext = await browser.newContext();
  networkAudit(restoredContext);
  try {
    const restored = await restoredContext.newPage();
    // This is a clean browser profile, which must acquire the program before the connection is cut.
    await openWorkspace(restored);
    await prepareOffline(restored);
    expect(await storedTexts(restored)).toEqual([]);

    dropNetwork = true;
    await context.setOffline(true);
    await restoredContext.setOffline(true);
    await restored.reload();
    await expect(restored.locator('#storage-status')).toHaveAttribute('data-state', 'ready');
    await restored.locator('#import-file').setInputFiles({
      name: download.suggestedFilename(),
      mimeType: 'text/plain',
      buffer: downloadedBytes,
    });
    await expect.poll(async () => (await storedTexts(restored)).length).toBe(1);
    const [imported] = await storedTexts(restored);
    expect(imported).toMatchObject({ kind: 'document', body: unsavedText, revision: 1 });
    await restored.reload();
    await expect(restored.locator('#storage-status')).toHaveAttribute('data-state', 'ready');
    await openRecord(restored, imported.id);
    await expect(restored.locator('#document-body')).toHaveValue(unsavedText);
  } finally {
    await restoredContext.close();
  }
});

test('keeps the editor and committed record intact when UTF-8 or NUL-containing imports are rejected', async ({ page }) => {
  await openWorkspace(page);
  await saveDraft(page, 'Texte précédent', 'Version déjà enregistrée.');
  const before = await storedTexts(page);
  const unsavedText = 'Modifications ouvertes à conserver même si le nouvel import échoue.';
  await fillUncommittedDraft(page, { body: unsavedText });
  const invalidFiles = [
    { name: 'utf8-invalide.txt', buffer: Buffer.from([0xc3, 0x28]) },
    { name: 'contient-nul.md', buffer: Buffer.from('Texte avant\0Texte après', 'utf8') },
  ];
  for (const file of invalidFiles) {
    // Accept replacing the edited document, then verify validation fails before any replacement.
    page.once('dialog', (dialog) => void dialog.accept());
    await page.locator('#import-file').setInputFiles({ ...file, mimeType: 'text/plain' });
    await expect(page.locator('#error-message')).toContainText('UTF-8 valide');
    await expect(page.locator('#import-file')).toBeEnabled();
    await expect(page.locator('#document-title')).toHaveValue('Texte précédent');
    await expect(page.locator('#document-body')).toHaveValue(unsavedText);
    await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'error');
    expect(await storedTexts(page)).toEqual(before);
  }
});


interface ArchiveText extends StoredText {
  createdAt: string;
  updatedAt: string;
  sourceName?: string;
}

interface LibraryArchive {
  format: 'purama-offline-texts';
  version: 1;
  exportedAt: string;
  records: ArchiveText[];
}

function portableText(record: StoredText): ArchiveText {
  const stored = record as ArchiveText;
  const exported: ArchiveText = {
    id: stored.id, kind: stored.kind, title: stored.title, body: stored.body,
    revision: stored.revision, createdAt: stored.createdAt, updatedAt: stored.updatedAt,
  };
  if (stored.sourceName !== undefined) exported.sourceName = stored.sourceName;
  return exported;
}

function archiveRecord(id: string, overrides: Partial<ArchiveText> = {}): ArchiveText {
  return {
    id, kind: 'draft', title: 'Texte sauvegardé', body: 'Contenu à restaurer.',
    revision: 1,
    createdAt: '2026-11-10T08:00:00.000Z',
    updatedAt: '2026-11-10T09:00:00.000Z',
    ...overrides,
  };
}

function libraryBytes(records: ArchiveText[]): Buffer {
  return Buffer.from(JSON.stringify({
    format: 'purama-offline-texts', version: 1,
    exportedAt: '2026-11-10T12:00:00.000Z', records,
  }), 'utf8');
}

async function previewLibrary(page: Page, bytes: Buffer) {
  await page.locator('#restore-file').setInputFiles({
    name: 'bibliotheque-purama.json', mimeType: 'application/json', buffer: bytes,
  });
  await expect(page.locator('#backup-status')).toHaveAttribute('data-state', 'preview');
  await expect(page.locator('#restore-preview')).toBeVisible();
}

async function confirmLibrary(page: Page) {
  await page.locator('#confirm-restore').click();
  await expect(page.locator('#backup-status')).toHaveAttribute('data-state', 'success');
}

async function downloadLibrary(page: Page): Promise<{ bytes: Buffer; archive: LibraryArchive; filename: string }> {
  const downloaded = page.waitForEvent('download');
  await page.locator('#backup-library').click();
  const download = await downloaded;
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  if (!path) throw new Error('The completed library download must be available to the test');
  const bytes = await readFile(path);
  return { bytes, archive: JSON.parse(bytes.toString('utf8')) as LibraryArchive, filename: download.suggestedFilename() };
}

test('backs up every saved text and restores the library offline in a fresh profile', async ({ page, context, browser, networkAudit }, testInfo) => {
  await openWorkspace(page);
  // Keep this explicit assertion before preparation so the baseline RED diagnoses
  // the missing feature, independently of the next cache version.
  await expect(page.locator('#backup-library')).toBeVisible();
  await prepareOffline(page);
  await saveDraft(page, 'Carnet repère-bleu', 'Texte présent sous deux identifiants distincts.');
  await page.locator('#new-draft').click();
  await saveDraft(page, 'Second carnet', 'Texte présent sous deux identifiants distincts.');
  await page.locator('#import-file').setInputFiles({
    name: 'notes-terrain.md', mimeType: 'text/markdown',
    buffer: Buffer.from('Forêt, Genève, été. 🧭\n<script>texte brut uniquement</script>\n'),
  });
  await expect.poll(async () => (await storedTexts(page)).length).toBe(3);
  const before = await storedTexts(page);
  const selected = before.find((record) => record.title === 'Carnet repère-bleu')!;
  await openRecord(page, selected.id);
  const dirtyBody = 'Modifications ouvertes qui ne font pas partie de la sauvegarde des textes enregistrés.';
  await fillUncommittedDraft(page, { title: 'Titre ouvert non enregistré', body: dirtyBody });
  await page.locator('#search-input').fill('repère-bleu');
  await expect(page.locator('#document-list button[data-record-id]')).toHaveCount(1);

  const exported = await downloadLibrary(page);
  expect(exported.filename).toMatch(/\.json$/);
  expect(Object.keys(exported.archive).sort()).toEqual(['exportedAt', 'format', 'records', 'version']);
  expect(exported.archive).toMatchObject({ format: 'purama-offline-texts', version: 1 });
  expect(new Date(exported.archive.exportedAt).toISOString()).toBe(exported.archive.exportedAt);
  expect(exported.archive.records.slice().sort((a, b) => a.id.localeCompare(b.id)))
    .toEqual(before.map(portableText).sort((a, b) => a.id.localeCompare(b.id)));
  expect(exported.archive.records.some((record) => record.kind === 'document' && record.sourceName === 'notes-terrain.md')).toBe(true);
  await expect(page.locator('#document-title')).toHaveValue('Titre ouvert non enregistré');
  await expect(page.locator('#document-body')).toHaveValue(dirtyBody);
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'error');
  expect(await storedTexts(page)).toEqual(before);

  const restoredContext = await browser.newContext();
  networkAudit(restoredContext);
  try {
    const restored = await restoredContext.newPage();
    await openWorkspace(restored);
    await prepareOffline(restored);
    expect(await storedTexts(restored)).toEqual([]);
    dropNetwork = true;
    await context.setOffline(true);
    await restoredContext.setOffline(true);
    const response = await restored.reload();
    expect(response?.fromServiceWorker()).toBe(true);
    await expect(restored.locator('#storage-status')).toHaveAttribute('data-state', 'ready');
    await fillUncommittedDraft(restored, {
      title: 'Brouillon ouvert dans le nouveau profil',
      body: 'Ne pas remplacer cet éditeur pendant la restauration.',
    });
    await previewLibrary(restored, exported.bytes);
    expect(await storedTexts(restored), 'Preview must not commit a single record').toEqual([]);
    await expect(restored.locator('#document-body')).toHaveValue('Ne pas remplacer cet éditeur pendant la restauration.');
    await confirmLibrary(restored);
    const restoredRecords = await storedTexts(restored);
    expect(restoredRecords.map(portableText).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual(before.map(portableText).sort((a, b) => a.id.localeCompare(b.id)));
    await expect(restored.locator('#document-title')).toHaveValue('Brouillon ouvert dans le nouveau profil');
    await expect(restored.locator('#document-body')).toHaveValue('Ne pas remplacer cet éditeur pendant la restauration.');
    await expect(restored.locator('#save-status')).toHaveAttribute('data-state', 'error');
    await testInfo.attach('offline-library-restoration.json', {
      body: Buffer.from(JSON.stringify({
        exportedRecords: exported.archive.records.length,
        restoredRecords: restoredRecords.length,
        downloadedBytes: exported.bytes.length,
        offlineEmulation: true, serverDropsConnections: dropNetwork,
        droppedConnections, fromServiceWorker: response?.fromServiceWorker(),
      }, null, 2)),
      contentType: 'application/json',
    });
    // Accept discarding only the unsaved editor, then prove the imported records
    // survive a real offline reload.
    restored.once('dialog', (dialog) => void dialog.accept());
    await restored.reload();
    await expect(restored.locator('#storage-status')).toHaveAttribute('data-state', 'ready');
    expect((await storedTexts(restored)).map(portableText).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual(before.map(portableText).sort((a, b) => a.id.localeCompare(b.id)));
  } finally {
    await restoredContext.close();
  }
});

test('restores distinct IDs idempotently after editing and accepts a clock rollback', async ({ page }) => {
  await openWorkspace(page);
  const first = archiveRecord('a10b0496-b7e5-4fab-94ea-111111111111', {
    title: 'Premier exemplaire', body: 'Même texte, deux identifiants à conserver.', revision: 7,
    createdAt: '2026-11-10T10:00:00.000Z', updatedAt: '2026-11-10T09:00:00.000Z',
  });
  const second = archiveRecord('b20b0496-b7e5-4fab-94ea-222222222222', {
    title: 'Second exemplaire', body: first.body, kind: 'document', sourceName: 'origine.md',
  });
  const bytes = libraryBytes([first, second]);
  await previewLibrary(page, bytes);
  expect(await storedTexts(page)).toEqual([]);
  await confirmLibrary(page);
  expect((await storedTexts(page)).map(portableText).sort((a, b) => a.id.localeCompare(b.id)))
    .toEqual([first, second].sort((a, b) => a.id.localeCompare(b.id)));
  await previewLibrary(page, bytes);
  await confirmLibrary(page);
  expect(await storedTexts(page)).toHaveLength(2);
  await openRecord(page, first.id);
  await saveDraft(page, 'Premier exemplaire modifié', 'Version modifiée après la première restauration.');
  const afterEdit = await storedTexts(page);
  const editedFirst = afterEdit.find((record) => record.id === first.id)!;
  expect(editedFirst).toMatchObject({ title: 'Premier exemplaire modifié', body: 'Version modifiée après la première restauration.' });
  expect(editedFirst.revision).toBeGreaterThan(first.revision);
  expect(editedFirst.revision).toBeLessThanOrEqual(first.revision + 2);
  await previewLibrary(page, bytes);
  await confirmLibrary(page);
  expect(await storedTexts(page)).toEqual(afterEdit);
  expect(await page.evaluate(async (name) => {
    const databases = await indexedDB.databases();
    return databases.find((database) => database.name === name)?.version;
  }, databaseName)).toBe(1);
  const reexported = await downloadLibrary(page);
  expect(reexported.archive.records).toHaveLength(2);
  expect(reexported.archive.records.every((record) => !Object.hasOwn(record, 'restoreKey'))).toBe(true);
  expect(reexported.archive.records.map(portableText).sort((a, b) => a.id.localeCompare(b.id)))
    .toEqual(afterEdit.map(portableText).sort((a, b) => a.id.localeCompare(b.id)));
});

test('preserves both versions on an ID conflict and never recreates an edited imported copy', async ({ page }) => {
  await openWorkspace(page);
  await saveDraft(page, 'Version présente dans ce navigateur', 'Texte local à ne jamais écraser.');
  const [original] = await storedTexts(page);
  // This record predates any restore marker: exact identity must still be skipped.
  await previewLibrary(page, libraryBytes([portableText(original)]));
  await confirmLibrary(page);
  expect(await storedTexts(page)).toEqual([original]);
  const conflicting = {
    ...portableText(original), title: 'É'.repeat(160),
    body: 'Version différente conservée dans la sauvegarde.', revision: 12,
  };
  const bytes = libraryBytes([conflicting]);
  await fillUncommittedDraft(page, { body: 'Édition locale non enregistrée pendant la restauration.' });
  await previewLibrary(page, bytes);
  expect(await storedTexts(page)).toEqual([original]);
  await confirmLibrary(page);
  const records = await storedTexts(page);
  expect(records).toHaveLength(2);
  expect(records.find((record) => record.id === original.id)).toEqual(original);
  const copy = records.find((record) => record.id !== original.id)!;
  expect(copy.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(copy).toMatchObject({ body: conflicting.body, revision: 1, kind: original.kind });
  expect(copy.title).toMatch(/ — restauré$/);
  expect(copy.title.length).toBeLessThanOrEqual(160);
  await expect(page.locator('#document-body')).toHaveValue('Édition locale non enregistrée pendant la restauration.');
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'error');
  page.once('dialog', (dialog) => void dialog.accept());
  await openRecord(page, copy.id);
  await saveDraft(page, 'Copie restaurée puis éditée', 'La copie a maintenant ses propres modifications.');
  const edited = await storedTexts(page);
  await previewLibrary(page, bytes);
  await confirmLibrary(page);
  expect(await storedTexts(page)).toEqual(edited);
  expect(edited.find((record) => record.id === original.id)).toEqual(original);
});

test('cancels a validated library preview without writing or changing a dirty editor', async ({ page }) => {
  await openWorkspace(page);
  await saveDraft(page, 'Texte déjà présent', 'Version durable avant prévisualisation.');
  const before = await storedTexts(page);
  await fillUncommittedDraft(page, {
    title: 'Titre encore non enregistré', body: 'Brouillon sale à conserver après annulation.',
  });
  await previewLibrary(page, libraryBytes([
    archiveRecord('c30b0496-b7e5-4fab-94ea-333333333333'),
  ]));
  expect(await storedTexts(page)).toEqual(before);
  await page.locator('#cancel-restore').click();
  await expect(page.locator('#restore-preview')).toBeHidden();
  await expect(page.locator('#backup-status')).toHaveAttribute('data-state', 'idle');
  expect(await storedTexts(page)).toEqual(before);
  await expect(page.locator('#document-title')).toHaveValue('Titre encore non enregistré');
  await expect(page.locator('#document-body')).toHaveValue('Brouillon sale à conserver après annulation.');
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'error');
});


test('rejects malformed libraries entirely without any write or dirty-editor replacement', async ({ page }) => {
  await openWorkspace(page);
  await saveDraft(page, 'Base locale', 'Contenu déjà validé dans ce navigateur.');
  const before = await storedTexts(page);
  await fillUncommittedDraft(page, { title: 'Titre ouvert à garder', body: 'Modifications non enregistrées à garder.' });
  const valid = archiveRecord('d40b0496-b7e5-4fab-94ea-444444444444');
  const validEnvelope = JSON.parse(libraryBytes([valid]).toString('utf8')) as LibraryArchive;
  const malformedParts = libraryBytes([{ ...valid, body: 'BAD_UTF8' }]).toString('utf8').split('BAD_UTF8');
  const badFiles = [
    { name: 'version-inconnue.json', buffer: Buffer.from(JSON.stringify({ ...validEnvelope, version: 2 })) },
    { name: 'champ-racine-inconnu.json', buffer: Buffer.from(JSON.stringify({ ...validEnvelope, unexpected: true })) },
    { name: 'champ-texte-inconnu.json', buffer: Buffer.from(JSON.stringify({ ...validEnvelope, records: [valid, { ...valid, id: 'bad-extra', unexpected: true }] })) },
    { name: 'marque-interne-interdite.json', buffer: Buffer.from(JSON.stringify({ ...validEnvelope, records: [{ ...valid, restoreKey: 'not-an-archive-field' }] })) },
    { name: 'ids-dupliques.json', buffer: libraryBytes([valid, { ...valid, title: 'Même ID dans le même fichier' }]) },
    { name: 'date-invalide.json', buffer: libraryBytes([valid, { ...valid, id: 'bad-date', createdAt: 'not-an-ISO-date' }]) },
    { name: 'date-export-invalide.json', buffer: Buffer.from(JSON.stringify({ ...validEnvelope, exportedAt: 'not-an-ISO-date' })) },
    { name: 'revision-invalide.json', buffer: libraryBytes([valid, { ...valid, id: 'bad-revision', revision: 0 }]) },
    { name: 'titre-trop-long.json', buffer: libraryBytes([valid, { ...valid, id: 'bad-title', title: 'T'.repeat(161) }]) },
    { name: 'corps-trop-grand.json', buffer: libraryBytes([valid, { ...valid, id: 'bad-body', body: 'é'.repeat(524_289) }]) },
    { name: 'trop-de-textes.json', buffer: libraryBytes(Array.from({ length: 2001 }, (_, index) => archiveRecord('bulk-' + index))) },
    { name: 'utf8-invalide.json', buffer: Buffer.concat([Buffer.from(malformedParts[0]), Buffer.from([0xc3, 0x28]), Buffer.from(malformedParts[1])]) },
  ];
  await page.evaluate(() => {
    const audit = { writes: 0 };
    (window as unknown as Record<string, unknown>).__invalidLibraryAudit = audit;
    for (const method of ['add', 'put'] as const) {
      const original = IDBObjectStore.prototype[method];
      Object.defineProperty(IDBObjectStore.prototype, method, {
        configurable: true, writable: true,
        value(this: IDBObjectStore, ...args: [unknown, IDBValidKey?]) {
          if (this.name === 'texts') audit.writes += 1;
          return original.apply(this, args);
        },
      });
    }
  });
  // A rejected new file must also invalidate a previously valid pending preview.
  await previewLibrary(page, libraryBytes([valid]));
  for (const file of badFiles) {
    await page.locator('#restore-file').setInputFiles({ ...file, mimeType: 'application/json' });
    await expect(page.locator('#backup-status'), file.name).toHaveAttribute('data-state', 'error');
    await expect(page.locator('#restore-file')).toBeEnabled();
    await expect(page.locator('#restore-preview')).toBeHidden();
    await expect(page.locator('#document-title')).toHaveValue('Titre ouvert à garder');
    await expect(page.locator('#document-body')).toHaveValue('Modifications non enregistrées à garder.');
    await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'error');
    expect(await storedTexts(page), file.name).toEqual(before);
  }
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__invalidLibraryAudit))
    .toEqual({ writes: 0 });
});

for (const failure of ['quota-on-second-add', 'abort-after-second-add-success'] as const) {
  test('rolls back the entire library transaction on ' + failure, async ({ page }) => {
    await openWorkspace(page);
    await saveDraft(page, 'Dernier état durable', 'Le lot échoué ne doit pas toucher cette version.');
    const before = await storedTexts(page);
    await fillUncommittedDraft(page, {
      title: 'Titre non enregistré avant incident', body: 'Brouillon conservé pendant et après incident.',
    });
    const bytes = libraryBytes([
      archiveRecord('e50b0496-b7e5-4fab-94ea-555555555555', { title: 'Premier ajout du lot' }),
      archiveRecord('f60b0496-b7e5-4fab-94ea-666666666666', { title: 'Deuxième ajout du lot' }),
    ]);
    await previewLibrary(page, bytes);
    expect(await storedTexts(page)).toEqual(before);
    await page.evaluate((injectedFailure) => {
      const originalAdd = IDBObjectStore.prototype.add;
      const originalPut = IDBObjectStore.prototype.put;
      const originalTransaction = IDBDatabase.prototype.transaction;
      const audit = { addCalls: 0, putCalls: 0, readwrite: 0, completed: 0, aborted: 0, addSuccesses: 0 };
      const globals = window as unknown as Record<string, unknown>;
      globals.__libraryWriteAudit = audit;
      Object.defineProperty(IDBDatabase.prototype, 'transaction', {
        configurable: true, writable: true,
        value(this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
          const transaction = originalTransaction.apply(this, args);
          if (this.name === 'purama-offline-workspace' && args[1] === 'readwrite') {
            audit.readwrite += 1;
            transaction.addEventListener('complete', () => { audit.completed += 1; });
            transaction.addEventListener('abort', () => { audit.aborted += 1; });
          }
          return transaction;
        },
      });
      Object.defineProperty(IDBObjectStore.prototype, 'put', {
        configurable: true, writable: true,
        value(this: IDBObjectStore, ...args: [unknown, IDBValidKey?]) {
          if (this.name === 'texts') audit.putCalls += 1;
          return originalPut.apply(this, args);
        },
      });
      Object.defineProperty(IDBObjectStore.prototype, 'add', {
        configurable: true, writable: true,
        value(this: IDBObjectStore, ...args: [unknown, IDBValidKey?]) {
          if (this.name !== 'texts') return originalAdd.apply(this, args);
          audit.addCalls += 1;
          const call = audit.addCalls;
          if (call === 2 && injectedFailure === 'quota-on-second-add') {
            // Inject only the named failure; all storage before it is real IndexedDB.
            throw new DOMException('Quota failure on second archive add', 'QuotaExceededError');
          }
          const request = originalAdd.apply(this, args);
          request.addEventListener('success', () => {
            audit.addSuccesses += 1;
            if (call === 2 && injectedFailure === 'abort-after-second-add-success') {
              // Both request successes have happened. Neither is a durable commit.
              this.transaction.abort();
            }
          });
          return request;
        },
      });
      globals.__clearLibraryWriteFault = () => {
        IDBObjectStore.prototype.add = originalAdd;
        IDBObjectStore.prototype.put = originalPut;
        IDBDatabase.prototype.transaction = originalTransaction;
      };
    }, failure);

    await page.locator('#confirm-restore').click();
    await expect(page.locator('#backup-status')).toHaveAttribute('data-state', 'error');
    expect(await storedTexts(page), 'No first-record partial commit is permitted').toEqual(before);
    const audit = await page.evaluate(() => (window as unknown as Record<string, unknown>).__libraryWriteAudit);
    expect(audit).toMatchObject({ addCalls: 2, putCalls: 0, readwrite: 1, completed: 0, aborted: 1 });
    if (failure === 'abort-after-second-add-success') expect(audit).toMatchObject({ addSuccesses: 2 });
    await expect(page.locator('#document-title')).toHaveValue('Titre non enregistré avant incident');
    await expect(page.locator('#document-body')).toHaveValue('Brouillon conservé pendant et après incident.');
    await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'error');

    // Recovery must be possible without a reload or losing the dirty editor.
    await page.evaluate(() => {
      (window as unknown as Record<string, () => void>).__clearLibraryWriteFault();
    });
    await previewLibrary(page, bytes);
    await confirmLibrary(page);
    expect(await storedTexts(page)).toHaveLength(before.length + 2);
    await expect(page.locator('#document-body')).toHaveValue('Brouillon conservé pendant et après incident.');
    await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'error');
  });
}

test('never announces offline readiness when the backup module is missing', async ({ page }) => {
  await openWorkspace(page);
  unavailableAssets.add('/offline-library-backup.js');
  await page.locator('#prepare-offline').click();
  await expect(page.locator('#preparation-status')).toHaveAttribute('data-state', /^(error|missing)$/, { timeout: 15_000 });
  await expect(page.locator('#preparation-status')).not.toHaveAttribute('data-state', 'ready');
});


test('exports a near-limit library without counting internal restore markers', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await openWorkspace(page);
  expect(await storedTexts(page)).toEqual([]);
  const { createHash } = await import('node:crypto');
  const maximumBytes = 32 * 1024 * 1024;
  const targetBytes = maximumBytes - 128;
  const bodyLimit = 1024 * 1024;
  const records = Array.from({ length: 32 }, (_, index): ArchiveText => ({
    id: 'a10b0496-b7e5-4fab-94ea-' + (index + 1).toString(16).padStart(12, '0'),
    kind: 'draft', title: 'Boundary text ' + (index + 1),
    body: String.fromCharCode(65 + (index % 26)).repeat(bodyLimit),
    revision: 1,
    createdAt: '2026-11-10T08:00:00.000Z',
    updatedAt: '2026-11-10T09:00:00.000Z',
  }));
  // Build the public contract independently. Never import or call the application's serializer.
  const fixtureArchive: LibraryArchive = {
    format: 'purama-offline-texts', version: 1,
    exportedAt: '2026-11-10T12:00:00.000Z', records,
  };
  const excessBytes = Buffer.byteLength(JSON.stringify(fixtureArchive), 'utf8') - targetBytes;
  expect(excessBytes).toBeGreaterThan(0);
  expect(excessBytes).toBeLessThan(bodyLimit);
  const last = records[records.length - 1];
  last.body = last.body.slice(0, last.body.length - excessBytes);
  expect(Buffer.byteLength(JSON.stringify(fixtureArchive), 'utf8')).toBe(targetBytes);
  expect(records.every((record) => Buffer.byteLength(record.body, 'utf8') <= bodyLimit)).toBe(true);

  const specifications = records.map((record, index) => {
    const { body, ...metadata } = record;
    return {
      ...metadata,
      bodyCharacter: body[0], bodyLength: body.length,
      bodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      restoreKey: (index + 1).toString(16).padStart(64, '0'),
    };
  });
  const rawStoredBytes = records.reduce((total, record, index) => total
    + Buffer.byteLength(JSON.stringify({ ...record, restoreKey: specifications[index].restoreKey }), 'utf8'), 0);
  expect(rawStoredBytes, 'The former raw-row guard would incorrectly refuse this valid archive').toBeGreaterThan(maximumBytes);

  // Send only small fixture specifications over the browser protocol, then create
  // the real 32 MiB data inside IndexedDB. No successful storage operation is mocked.
  await page.evaluate(({ name, specifications: specs }) => new Promise<void>((resolveStored, reject) => {
    const request = indexedDB.open(name);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('texts', 'readwrite');
      const store = transaction.objectStore('texts');
      transaction.oncomplete = () => { database.close(); resolveStored(); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
      for (const spec of specs) {
        store.add({
          id: spec.id, kind: spec.kind, title: spec.title,
          body: spec.bodyCharacter.repeat(spec.bodyLength), revision: spec.revision,
          createdAt: spec.createdAt, updatedAt: spec.updatedAt, restoreKey: spec.restoreKey,
        });
      }
    };
  }), { name: databaseName, specifications });

  const exported = await downloadLibrary(page);
  await expect(page.locator('#backup-status')).toHaveAttribute('data-state', 'success');
  expect(exported.bytes.length).toBeLessThanOrEqual(maximumBytes);
  expect(exported.archive).toMatchObject({ format: 'purama-offline-texts', version: 1 });
  expect(exported.archive.records).toHaveLength(32);
  const expectedFields = ['body', 'createdAt', 'id', 'kind', 'revision', 'title', 'updatedAt'];
  for (const record of exported.archive.records) {
    const expected = specifications.find((spec) => spec.id === record.id)!;
    expect(expected, 'Every exported record must belong to the fixture').toBeDefined();
    expect(Object.keys(record).sort()).toEqual(expectedFields);
    const { body, ...metadata } = record;
    const original = records.find((item) => item.id === record.id)!;
    expect(metadata).toEqual({
      id: original.id, kind: original.kind, title: original.title, revision: original.revision,
      createdAt: original.createdAt, updatedAt: original.updatedAt,
    });
    expect(Buffer.byteLength(body, 'utf8')).toBe(expected.bodyLength);
    expect(createHash('sha256').update(body, 'utf8').digest('hex')).toBe(expected.bodySha256);
  }
  expect(new Set(exported.archive.records.map((record) => record.id)).size).toBe(32);

  // Return only fingerprints and metadata, not another 32 MiB archive, to prove
  // that export neither erased a record nor altered its body or internal marker.
  const after = await page.evaluate(async (name) => {
    const rows = await new Promise<(ArchiveText & { restoreKey: string })[]>((resolveRows, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('texts', 'readonly');
        const all = transaction.objectStore('texts').getAll();
        transaction.oncomplete = () => { database.close(); resolveRows(all.result); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      };
    });
    return Promise.all(rows.map(async (record) => {
      const { body, ...metadata } = record;
      const encoded = new TextEncoder().encode(body);
      const hash = await crypto.subtle.digest('SHA-256', encoded);
      return {
        ...metadata, bodyLength: encoded.byteLength,
        bodySha256: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(''),
      };
    }));
  }, databaseName);
  const expectedStored = specifications.map((spec) => ({
    id: spec.id, kind: spec.kind, title: spec.title, revision: spec.revision,
    createdAt: spec.createdAt, updatedAt: spec.updatedAt, restoreKey: spec.restoreKey,
    bodyLength: spec.bodyLength, bodySha256: spec.bodySha256,
  }));
  expect(after.sort((a, b) => a.id.localeCompare(b.id)))
    .toEqual(expectedStored.sort((a, b) => a.id.localeCompare(b.id)));
  await testInfo.attach('library-size-boundary-metrics.json', {
    body: Buffer.from(JSON.stringify({
      maximumBytes, targetBytes, rawStoredBytes,
      downloadedBytes: exported.bytes.length,
      recordCount: exported.archive.records.length,
      storedRecordCountAfterExport: after.length,
      archiveSha256: createHash('sha256').update(exported.bytes).digest('hex'),
      internalMarkersExported: exported.archive.records.filter((record) => Object.hasOwn(record, 'restoreKey')).length,
    }, null, 2)),
    contentType: 'application/json',
  });
});


// These voice scenarios exercise the real UI with an explicit Web Speech double.
// They prove voice selection, bounded sequencing and cancellation, not physical
// sound output, OS voice installation, or a browser engine's localService claim.
interface LocalSpeechTestVoice {
  name: string;
  lang: string;
  voiceURI: string;
  localService: boolean;
  default: boolean;
}
interface LocalSpeechTestProbe {
  calls: Array<{ text: string; voice: LocalSpeechTestVoice | null; installed: boolean }>;
  cancelCount: number;
  setVoices(voices: LocalSpeechTestVoice[]): void;
  setThrowOnSpeak(throws: boolean): void;
  setThrowOnCancel(throws: boolean): void;
  setThrowOnGetVoices(throws: boolean): void;
  emit(index: number, type: 'start' | 'end' | 'error'): void;
  finishAll(limit?: number): Promise<void>;
}
declare global {
  interface Window { __puramaLocalSpeechTest: LocalSpeechTestProbe }
}
const localFrenchVoice: LocalSpeechTestVoice = {
  name: 'Voix française locale de test', lang: 'fr-FR', voiceURI: 'test:fr-local', localService: true, default: false,
};
const remoteFrenchVoice: LocalSpeechTestVoice = {
  name: 'Voix française distante de test', lang: 'fr-FR', voiceURI: 'test:fr-remote', localService: false, default: true,
};
const localEnglishVoice: LocalSpeechTestVoice = {
  name: 'English local test voice', lang: 'en-US', voiceURI: 'test:en-local', localService: true, default: false,
};

async function installLocalSpeechDouble(page: Page, voices: LocalSpeechTestVoice[], options: { absent?: boolean; throwOnSpeak?: boolean } = {}) {
  await page.addInitScript(({ initialVoices, settings }) => {
    let availableVoices = initialVoices;
    let throwOnSpeak = settings.throwOnSpeak === true;
    let throwOnCancel = false;
    let throwOnGetVoices = false;
    type Callback = ((event: Event) => void) | null;
    class TestUtterance {
      text: string;
      voice: LocalSpeechTestVoice | null = null;
      onstart: Callback = null;
      onend: Callback = null;
      onerror: Callback = null;
      constructor(text: string) { this.text = text; }
    }
    const callbacks: Array<{ start: Callback; end: Callback; error: Callback }> = [];
    const probe: LocalSpeechTestProbe = {
      calls: [], cancelCount: 0,
      setVoices(next) { availableVoices = next; synth.dispatchEvent(new Event('voiceschanged')); },
      setThrowOnSpeak(throws) { throwOnSpeak = throws; },
      setThrowOnCancel(throws) { throwOnCancel = throws; },
      setThrowOnGetVoices(throws) { throwOnGetVoices = throws; },
      // Keep captured callbacks after cancel() to deliberately emulate stale events.
      emit(index, type) { callbacks[index]?.[type]?.(new Event(type)); },
      async finishAll(limit = 200) {
        for (let index = 0; index < callbacks.length && index < limit; index += 1) {
          probe.emit(index, 'end');
          await new Promise<void>((resolveNext) => queueMicrotask(resolveNext));
        }
      },
    };
    const synth = Object.assign(new EventTarget(), {
      getVoices() {
        if (throwOnGetVoices) throw new Error('Injected voice-list failure');
        return [...availableVoices];
      },
      speak(utterance: TestUtterance) {
        probe.calls.push({ text: utterance.text, voice: utterance.voice ? { ...utterance.voice } : null,
          installed: Boolean(utterance.voice && availableVoices.includes(utterance.voice)) });
        callbacks.push({ start: utterance.onstart, end: utterance.onend, error: utterance.onerror });
        if (throwOnSpeak) throw new Error('Injected synchronous speech failure');
        utterance.onstart?.(new Event('start'));
      },
      cancel() {
        probe.cancelCount += 1;
        if (throwOnCancel) throw new Error('Injected cancellation failure');
      },
    });
    Object.defineProperty(window, '__puramaLocalSpeechTest', { configurable: true, value: probe });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: settings.absent ? undefined : synth });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: settings.absent ? undefined : TestUtterance });
  }, { initialVoices: voices, settings: options });
}

test('local speech: refuses remote-only French voices without calling speak', async ({ page }) => {
  await installLocalSpeechDouble(page, [remoteFrenchVoice, localEnglishVoice]);
  await openWorkspace(page);
  await page.locator('#document-body').fill('Ce texte doit rester sur cet appareil.');
  await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'unavailable');
  await expect(page.locator('#speak-text')).toBeDisabled();
  // The handler itself fails closed, even when a synthetic click bypasses disabled UI.
  await page.locator('#speak-text').dispatchEvent('click');
  expect(await page.evaluate(() => window.__puramaLocalSpeechTest.calls)).toEqual([]);
  await expect(page.locator('#document-body')).toHaveValue('Ce texte doit rester sur cet appareil.');
});

test('local speech: unavailable API leaves editing and saving usable', async ({ page }) => {
  await installLocalSpeechDouble(page, [], { absent: true });
  await openWorkspace(page);
  await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'unsupported');
  await saveDraft(page, 'Sans voix', 'Je peux toujours écrire et enregistrer.');
  await expect(page.locator('#speak-text')).toBeDisabled();
  expect((await storedTexts(page))[0].body).toBe('Je peux toujours écrire et enregistrer.');
  expect(await page.evaluate(() => window.__puramaLocalSpeechTest.calls)).toEqual([]);
});

test('local speech: explicitly selects an installed French local voice for an unsaved text offline', async ({ page, context }) => {
  await installLocalSpeechDouble(page, [remoteFrenchVoice, localEnglishVoice, localFrenchVoice]);
  await openWorkspace(page);
  expect(await page.evaluate(() => window.__puramaLocalSpeechTest.calls)).toEqual([]);
  const body = '  Brouillon non enregistré : bonjour, Matiss.\n';
  await fillUncommittedDraft(page, { body });
  await prepareOffline(page);
  dropNetwork = true;
  await context.setOffline(true);
  await page.locator('#speak-text').click();
  await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'speaking');
  const calls = await page.evaluate(() => window.__puramaLocalSpeechTest.calls);
  expect(calls).toEqual([{ text: body, voice: localFrenchVoice, installed: true }]);
  expect(await storedTexts(page)).toEqual([]);
  await page.evaluate(() => window.__puramaLocalSpeechTest.emit(0, 'end'));
  await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'complete');
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'error');
});

test('local speech: reacts to late voices and stops when the selected local voice disappears', async ({ page }) => {
  await installLocalSpeechDouble(page, []);
  await openWorkspace(page);
  await page.locator('#document-body').fill('Une voix peut devenir disponible après le chargement. '.repeat(8));
  await expect(page.locator('#speak-text')).toBeDisabled();
  await page.evaluate((voice) => window.__puramaLocalSpeechTest.setVoices([voice]), remoteFrenchVoice);
  await expect(page.locator('#speak-text')).toBeDisabled();
  await page.evaluate((voice) => window.__puramaLocalSpeechTest.setVoices([voice]), localFrenchVoice);
  await expect(page.locator('#speak-text')).toBeEnabled();
  await page.locator('#speak-text').click();
  await page.evaluate((voice) => window.__puramaLocalSpeechTest.setVoices([voice]), remoteFrenchVoice);
  await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'unavailable');
  await expect(page.locator('#stop-speech')).toBeDisabled();
  await page.evaluate(() => window.__puramaLocalSpeechTest.emit(0, 'end'));
  expect(await page.evaluate(() => window.__puramaLocalSpeechTest.calls.length)).toBe(1);
});

test('local speech: preserves every Unicode character while queuing one bounded segment at a time', async ({ page }) => {
  await installLocalSpeechDouble(page, [localFrenchVoice]);
  await openWorkspace(page);
  const body = ('Texte e\u0301 avec 🧑‍🚀 et 🌍, sans perte de caractères.\n').repeat(24);
  await page.locator('#document-body').fill(body);
  await page.locator('#speak-text').click();
  expect(await page.evaluate(() => window.__puramaLocalSpeechTest.calls.length)).toBe(1);
  await page.evaluate(() => window.__puramaLocalSpeechTest.finishAll());
  await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'complete');
  const calls = await page.evaluate(() => window.__puramaLocalSpeechTest.calls);
  expect(calls.length).toBeGreaterThan(1);
  expect(calls.map((call) => call.text).join('')).toBe(body);
  const boundaries = new Set([...new Intl.Segmenter('fr', { granularity: 'grapheme' }).segment(body)].map((part) => part.index));
  boundaries.add(body.length);
  let offset = 0;
  for (const call of calls) {
    expect(call.text.length).toBeGreaterThan(0);
    expect(call.text.length).toBeLessThanOrEqual(240);
    expect(call.voice?.localService).toBe(true);
    expect(call.installed).toBe(true);
    offset += call.text.length;
    expect(boundaries.has(offset)).toBe(true);
  }
});

test('local speech: fallback chunking preserves surrogate pairs when Intl Segmenter is absent', async ({ page }) => {
  await installLocalSpeechDouble(page, [localFrenchVoice]);
  await page.addInitScript(() => Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: undefined }));
  await openWorkspace(page);
  const body = 'a'.repeat(239) + '😀' + 'b'.repeat(239) + '😀' + ' fin';
  await page.locator('#document-body').fill(body);
  await page.locator('#speak-text').click();
  await page.evaluate(() => window.__puramaLocalSpeechTest.finishAll());
  await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'complete');
  const calls = await page.evaluate(() => window.__puramaLocalSpeechTest.calls);
  expect(calls.map((call) => call.text).join('')).toBe(body);
  for (const call of calls) {
    expect(call.text.length).toBeLessThanOrEqual(240);
    expect(/[\uD800-\uDBFF]$/.test(call.text)).toBe(false);
    expect(/^[\uDC00-\uDFFF]/.test(call.text)).toBe(false);
  }
});

test('local speech: stop and restart ignore late events from a previous reading', async ({ page }) => {
  await installLocalSpeechDouble(page, [localFrenchVoice]);
  await openWorkspace(page);
  await page.locator('#document-body').fill('Une lecture interrompue ne doit jamais reprendre toute seule. '.repeat(20));
  await page.locator('#speak-text').click();
  await page.locator('#stop-speech').click();
  await page.evaluate(() => {
    window.__puramaLocalSpeechTest.emit(0, 'start');
    window.__puramaLocalSpeechTest.emit(0, 'end');
  });
  await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'stopped');
  expect(await page.evaluate(() => window.__puramaLocalSpeechTest.calls.length)).toBe(1);
  await page.locator('#speak-text').click();
  await page.evaluate(() => window.__puramaLocalSpeechTest.emit(0, 'end'));
  expect(await page.evaluate(() => window.__puramaLocalSpeechTest.calls.length)).toBe(2);
  await page.evaluate(() => window.__puramaLocalSpeechTest.emit(1, 'end'));
  await expect.poll(() => page.evaluate(() => window.__puramaLocalSpeechTest.calls.length)).toBe(3);
  await page.locator('#stop-speech').click();
});

test('local speech: editing, changing document and a pagehide event stop playback', async ({ page }) => {
  await installLocalSpeechDouble(page, [localFrenchVoice]);
  await openWorkspace(page);
  await saveDraft(page, 'Premier', 'Premier texte disponible. '.repeat(20));
  const first = (await storedTexts(page))[0];
  await page.locator('#new-draft').click();
  await saveDraft(page, 'Second', 'Second texte disponible. '.repeat(20));
  await page.locator('#speak-text').click();
  await page.locator('#document-body').fill('Texte modifié pendant la lecture. '.repeat(20));
  await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'stopped');
  await page.evaluate(() => window.__puramaLocalSpeechTest.emit(0, 'end'));
  expect(await page.evaluate(() => window.__puramaLocalSpeechTest.calls.length)).toBe(1);
  await page.locator('#save-document').click();
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved');
  await page.locator('#speak-text').click();
  await openRecord(page, first.id);
  await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'stopped');
  await page.evaluate(() => window.__puramaLocalSpeechTest.emit(1, 'end'));
  expect(await page.evaluate(() => window.__puramaLocalSpeechTest.calls.length)).toBe(2);
  await page.locator('#speak-text').click();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'stopped');
  await page.evaluate(() => window.__puramaLocalSpeechTest.emit(2, 'end'));
  expect(await page.evaluate(() => window.__puramaLocalSpeechTest.calls.length)).toBe(3);
});

test('local speech: reports synchronous errors and allows an explicit retry', async ({ page }) => {
  await installLocalSpeechDouble(page, [localFrenchVoice], { throwOnSpeak: true });
  await openWorkspace(page);
  await page.locator('#document-body').fill('Une erreur ne signifie pas une lecture terminée.');
  await page.locator('#speak-text').click();
  await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#stop-speech')).toBeDisabled();
  await page.evaluate(() => {
    window.__puramaLocalSpeechTest.emit(0, 'end');
    window.__puramaLocalSpeechTest.setThrowOnSpeak(false);
  });
  await page.locator('#speak-text').click();
  await page.evaluate(() => window.__puramaLocalSpeechTest.emit(1, 'end'));
  await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'complete');
});

test('local speech: reports asynchronous failure without continuing the remaining text', async ({ page }) => {
  await installLocalSpeechDouble(page, [localFrenchVoice]);
  await openWorkspace(page);
  await page.locator('#document-body').fill('Le moteur peut échouer pendant un passage. '.repeat(20));
  await page.locator('#speak-text').click();
  await page.evaluate(() => window.__puramaLocalSpeechTest.emit(0, 'error'));
  await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'error');
  await page.evaluate(() => window.__puramaLocalSpeechTest.emit(0, 'end'));
  expect(await page.evaluate(() => window.__puramaLocalSpeechTest.calls.length)).toBe(1);
  await expect(page.locator('#stop-speech')).toBeDisabled();
});

test('local speech: stops a stalled utterance after the bounded timeout', async ({ page }) => {
  await page.clock.install();
  await installLocalSpeechDouble(page, [localFrenchVoice]);
  await openWorkspace(page);
  await page.locator('#document-body').fill('Le navigateur doit confirmer la fin de chaque passage. '.repeat(20));
  await page.locator('#speak-text').click();
  await page.clock.fastForward(45_001);
  await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#speech-status')).toContainText('n’a pas confirmé la fin');
  await page.evaluate(() => window.__puramaLocalSpeechTest.emit(0, 'end'));
  expect(await page.evaluate(() => window.__puramaLocalSpeechTest.calls.length)).toBe(1);
  await expect(page.locator('#speak-text')).toBeEnabled();
});

test('local speech: rejects a text exceeding one MiB before sending any utterance', async ({ page }) => {
  await installLocalSpeechDouble(page, [localFrenchVoice]);
  await openWorkspace(page);
  // A real textarea value/event avoids spending seconds synthesizing a MiB of key input.
  const length = await page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('#document-body')!;
    textarea.value = '😀'.repeat(262_145);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return textarea.value.length;
  });
  await page.locator('#speak-text').click();
  await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#speech-status')).toContainText('1 Mio');
  expect(await page.evaluate(() => window.__puramaLocalSpeechTest.calls)).toEqual([]);
  expect(await page.locator('#document-body').evaluate((element: HTMLTextAreaElement) => element.value.length)).toBe(length);
});


test('local speech: preserves an unconfirmed stop through voice replacement until explicit retry succeeds', async ({ page }) => {
  await installLocalSpeechDouble(page, [localFrenchVoice]);
  await openWorkspace(page);
  await page.locator('#document-body').fill('Une lecture dont l’arrêt est incertain ne doit pas être remplacée. '.repeat(20));
  await page.locator('#speak-text').click();
  const replacement = { ...localFrenchVoice, name: 'Autre voix française locale', voiceURI: 'test:fr-local-b' };
  await page.evaluate((voice) => {
    window.__puramaLocalSpeechTest.setThrowOnCancel(true);
    window.__puramaLocalSpeechTest.setVoices([voice]);
  }, replacement);
  await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'stop-unconfirmed');
  await expect(page.locator('#speech-status')).toContainText('n’a pas pu être confirmé');
  await expect(page.locator('#speak-text')).toBeDisabled();
  await expect(page.locator('#stop-speech')).toBeEnabled();
  await expect(page.locator('#stop-speech')).toHaveText('Réessayer l’arrêt');
  await page.evaluate((voice) => {
    window.__puramaLocalSpeechTest.setVoices([voice]);
    window.__puramaLocalSpeechTest.emit(0, 'end');
  }, replacement);
  await page.locator('#speak-text').dispatchEvent('click');
  await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'stop-unconfirmed');
  expect(await page.evaluate(() => window.__puramaLocalSpeechTest.calls.length)).toBe(1);
  await page.locator('#stop-speech').click();
  await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'stop-unconfirmed');
  await page.evaluate(() => window.__puramaLocalSpeechTest.setThrowOnCancel(false));
  await page.locator('#stop-speech').click();
  await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'stopped');
  await expect(page.locator('#stop-speech')).toBeDisabled();
  await page.locator('#speak-text').click();
  const calls = await page.evaluate(() => window.__puramaLocalSpeechTest.calls);
  expect(calls.length).toBe(2);
  expect(calls[1].voice).toEqual(replacement);
  await page.locator('#stop-speech').click();
});

for (const failure of ['missing-api', 'voice-list-error'] as const) {
  test('local speech: retains the original cancellation handle after ' + failure, async ({ page }) => {
    await installLocalSpeechDouble(page, [localFrenchVoice]);
    await openWorkspace(page);
    await page.locator('#document-body').fill('Le moyen d’arrêter doit rester accessible même si le service change. '.repeat(20));
    await page.locator('#speak-text').click();
    await page.evaluate(({ voice, fail }) => {
      const probe = window.__puramaLocalSpeechTest;
      probe.setThrowOnCancel(true);
      if (fail === 'missing-api') Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined });
      else probe.setThrowOnGetVoices(true);
      probe.setVoices([voice]);
    }, { voice: localFrenchVoice, fail: failure });
    await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'stop-unconfirmed');
    await expect(page.locator('#speak-text')).toBeDisabled();
    await expect(page.locator('#stop-speech')).toBeEnabled();
    await page.evaluate((voice) => window.__puramaLocalSpeechTest.setVoices([voice]), localFrenchVoice);
    await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'stop-unconfirmed');
    await page.evaluate(() => window.__puramaLocalSpeechTest.setThrowOnCancel(false));
    const cancellations = await page.evaluate(() => window.__puramaLocalSpeechTest.cancelCount);
    await page.locator('#stop-speech').click();
    expect(await page.evaluate(() => window.__puramaLocalSpeechTest.cancelCount)).toBe(cancellations + 1);
    await expect(page.locator('#speech-status')).toHaveAttribute('data-state', 'stopped');
    await expect(page.locator('#stop-speech')).toBeDisabled();
    await page.evaluate(() => window.__puramaLocalSpeechTest.emit(0, 'end'));
    expect(await page.evaluate(() => window.__puramaLocalSpeechTest.calls.length)).toBe(1);
  });
}


for (const withoutSegmenter of [false, true]) {
  test(`text integrity: imports complete Unicode titles offline${withoutSegmenter ? ' without Intl Segmenter' : ''}`, async ({ page, context }) => {
    if (withoutSegmenter) {
      await context.addInitScript(() => { Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: undefined }); });
    }
    await openWorkspace(page);
    await prepareOffline(page);
    dropNetwork = true;
    await context.setOffline(true);
    const prefix = 'a'.repeat(159);
    const sequences = withoutSegmenter ? ['😀'] : ['😀', 'e\u0301', '👨‍👩‍👧‍👦'];
    for (const [index, sequence] of sequences.entries()) {
      const name = `${prefix}${sequence}.md`;
      const body = `Corps intact ${index} : été, forêt, 🧭.\n<script>Texte littéral</script>\n`;
      await page.locator('#import-file').setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(body, 'utf8') });
      await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved');
      await expect(page.locator('#document-title')).toHaveValue(prefix);
      await expect(page.locator('#document-body')).toHaveValue(body);
      expect(await storedTexts(page)).toContainEqual(expect.objectContaining({ title: prefix, body, sourceName: name }));
    }
    const backup = await downloadLibrary(page);
    expect(backup.archive.records).toHaveLength(sequences.length);
    expect(backup.archive.records.every((record) => record.title === prefix)).toBe(true);
    await page.reload();
    await expect(page.locator('#storage-status')).toHaveAttribute('data-state', 'ready');
    expect(await storedTexts(page)).toHaveLength(sequences.length);
  });
}

test('text integrity: a conflict copy preserves a complete Unicode title and both bodies', async ({ page, context }) => {
  await context.addInitScript(() => { Reflect.deleteProperty(window, 'BroadcastChannel'); });
  await openWorkspace(page);
  const title = 'a'.repeat(149) + '😀' + 'b'.repeat(9);
  await saveDraft(page, title, 'Version initiale.');
  const [original] = await storedTexts(page);
  const other = await context.newPage();
  await openWorkspace(other);
  await openRecord(other, original.id);
  await fillUncommittedDraft(page, { body: 'Mon brouillon à préserver.' });
  await other.locator('#document-body').fill('Version concurrente à conserver.');
  await other.locator('#save-document').click();
  await expect(other.locator('#save-status')).toHaveAttribute('data-state', 'saved');
  await page.locator('#refresh-library').click();
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'conflict');
  await page.locator('#save-copy').click();
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved');
  await expect(page.locator('#document-title')).toHaveValue('a'.repeat(149) + ' — copie');
  const rows = await storedTexts(page);
  expect(rows).toHaveLength(2);
  expect(rows.find((record) => record.id === original.id)?.body).toBe('Version concurrente à conserver.');
  expect(rows.find((record) => record.id !== original.id)?.body).toBe('Mon brouillon à préserver.');
});

test('text integrity: exporting a Unicode filename preserves the unsaved title and exact body', async ({ page }) => {
  await openWorkspace(page);
  const title = 'a'.repeat(79) + '😀';
  const body = 'Texte non enregistré.\nÉté, famille 👨‍👩‍👧‍👦, e\u0301.\n';
  await fillUncommittedDraft(page, { title, body });
  const pending = page.waitForEvent('download');
  await page.locator('#export-document').click();
  const download = await pending;
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toBe('a'.repeat(79) + '.txt');
  const path = await download.path();
  if (!path) throw new Error('Completed local download missing');
  expect(await readFile(path)).toEqual(Buffer.from(body, 'utf8'));
  await expect(page.locator('#document-title')).toHaveValue(title);
  await expect(page.locator('#document-body')).toHaveValue(body);
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'error');
  expect(await storedTexts(page)).toEqual([]);
});

for (const action of ['save', 'delete', 'refresh'] as const) {
  for (const sameContent of [false, true]) {
    test(`text integrity: stale ${action} detects a recreated ID and revision${sameContent ? ' with only a new restore marker' : ' with different content'}`, async ({ page, context }) => {
      // A missing broadcast API is supported; transaction guards must stand on their own.
      await context.addInitScript(() => { Reflect.deleteProperty(window, 'BroadcastChannel'); });
      await openWorkspace(page);
      await saveDraft(page, 'Texte partagé', 'Ancienne version enregistrée.');
      const [original] = await storedTexts(page);
      const stale = await context.newPage();
      await openWorkspace(stale);
      await openRecord(stale, original.id);
      const draft = 'Brouillon ouvert à ne jamais perdre.';
      await fillUncommittedDraft(stale, { body: draft });
      page.once('dialog', (dialog) => void dialog.accept());
      await page.locator('#delete-document').click();
      await expect.poll(async () => (await storedTexts(page)).length).toBe(0);
      const incoming = { ...portableText(original), body: sameContent ? original.body : 'Version restaurée depuis une autre sauvegarde.' };
      const bytes = libraryBytes([incoming]);
      await previewLibrary(page, bytes);
      await confirmLibrary(page);
      const restored = (await storedTexts(page))[0] as StoredText & { restoreKey: string };
      expect(restored).toMatchObject(incoming);
      expect(restored.restoreKey).toMatch(/^[a-f0-9]{64}$/);
      // Do not move focus: exercise the real handler and final IndexedDB guard first.
      await expect(stale.locator('#save-status')).toHaveAttribute('data-state', 'error');
      if (action === 'delete') stale.once('dialog', (dialog) => void dialog.accept());
      const control = action === 'save' ? '#save-document' : action === 'delete' ? '#delete-document' : '#refresh-library';
      await stale.locator(control).evaluate((button: HTMLButtonElement) => button.click());
      await expect(stale.locator('#save-status')).toHaveAttribute('data-state', 'conflict');
      await expect(stale.locator('#save-document')).toBeDisabled();
      await expect(stale.locator('#save-copy')).toBeVisible();
      await expect(stale.locator('#document-body')).toHaveValue(draft);
      expect(await storedTexts(page)).toEqual([restored]);
      // An explicit reload adopts the restored snapshot and its marker.
      stale.once('dialog', (dialog) => void dialog.accept());
      await stale.locator('#reload-document').click();
      await expect(stale.locator('#document-body')).toHaveValue(incoming.body);
      await stale.locator('#document-body').fill('Modification après rechargement explicite.');
      await stale.locator('#save-document').click();
      await expect(stale.locator('#save-status')).toHaveAttribute('data-state', 'saved');
      const [edited] = await storedTexts(page) as (StoredText & { restoreKey: string })[];
      expect(edited.restoreKey).toBe(restored.restoreKey);
      await previewLibrary(page, bytes);
      await confirmLibrary(page);
      await expect(page.locator('#backup-status')).toContainText('0 ajoutés, 1 déjà présent');
      expect(await storedTexts(page)).toEqual([edited]);
    });
  }
}
