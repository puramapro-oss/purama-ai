import { test as base, expect } from '@playwright/test';

// This checks the compiled preview. The workspace suite has its own independent
// loopback server; neither suite imports the public-site fixture on port 4173.
const offlineOrigin = 'http://127.0.0.1:4187';
const modulePaths = ['/offline-workspace.js', '/offline-library-backup.js'];
const allowedPaths = new Set(['/offline.html', ...modulePaths, '/sw.js', '/favicon.ico']);
type NetworkEvent = { method: string; origin: string; path: string; decision: string };

const test = base.extend<{ offlineBuildNetwork: void }>({
  offlineBuildNetwork: [async ({ context, baseURL }, use, testInfo) => {
    expect(baseURL).toBe(offlineOrigin);
    const events: NetworkEvent[] = [];
    const unexpected: NetworkEvent[] = [];
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const allowed = url.origin === offlineOrigin && ['GET', 'HEAD'].includes(request.method())
        && allowedPaths.has(url.pathname);
      const event = {
        method: request.method(), origin: url.origin, path: url.pathname,
        decision: allowed ? 'allow-loopback-asset' : 'blocked-unexpected-request',
      };
      events.push(event);
      if (allowed) return route.continue();
      unexpected.push(event);
      await route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', (socket) => {
      const url = new URL(socket.url());
      const event = { method: 'WebSocket', origin: url.origin, path: url.pathname, decision: 'blocked-unexpected-request' };
      events.push(event);
      unexpected.push(event);
      socket.close();
    });
    await use();
    await testInfo.attach('offline-build-network-audit.json', {
      body: Buffer.from(JSON.stringify({ origin: offlineOrigin, externalRequestsForwarded: 0, events, unexpected }, null, 2)),
      contentType: 'application/json',
    });
    expect(unexpected, 'The compiled offline page may request only its loopback assets').toEqual([]);
  }, { auto: true }],
});

// Routing must observe every request in this compiled-assets check. Real worker
// installation, cache integrity and offline reloads are covered by the workspace.
test.use({ serviceWorkers: 'block' });

test('the built offline page loads its library modules and enforces its CSP', async ({ page }, testInfo) => {
  const pendingModules = modulePaths.map((path) => page.waitForResponse((response) =>
    response.url() === new URL(path, offlineOrigin).href));
  const [response, modules] = await Promise.all([
    page.goto('/offline.html'),
    Promise.all(pendingModules),
  ]);
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-type']).toMatch(/text\/html/i);
  await expect(page.locator('#storage-status')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#backup-library')).toBeVisible();
  await expect(page.locator('#backup-library')).toBeEnabled();
  await expect(page.locator('#restore-file')).toBeEnabled();
  await expect(page.locator('#restore-preview')).toBeHidden();
  await expect(page.locator('script[src="/offline-workspace.js"]')).toHaveCount(1);
  await expect(page.locator('script[src="/offline-workspace.js"]')).toHaveAttribute('type', 'module');

  // Inspect responses from the real module graph, not separate unguarded HTTP probes.
  for (const [index, asset] of modules.entries()) {
    expect(asset.status(), modulePaths[index]).toBe(200);
    expect(asset.request().redirectedFrom(), modulePaths[index]).toBeNull();
    expect(asset.headers()['content-type'], modulePaths[index]).toMatch(/(?:text|application)\/(?:java|ecma)script/i);
    const content = await asset.text();
    expect(content.trim().length, modulePaths[index]).toBeGreaterThan(0);
    expect(content.trimStart(), modulePaths[index]).not.toMatch(/^<!doctype\s+html|^<html/i);
  }

  const policyMeta = page.locator('meta[http-equiv="Content-Security-Policy"]');
  await expect(policyMeta).toHaveCount(1);
  const policy = await policyMeta.getAttribute('content');
  expect(policy).not.toBeNull();
  const directives = new Map(policy!.split(';').filter((part) => part.trim()).map((part) => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name, values] as const;
  }));
  for (const name of ['default-src', 'connect-src', 'base-uri', 'form-action', 'object-src']) {
    expect(directives.get(name), name).toEqual(["'none'"]);
  }
  expect(directives.get('script-src')).toEqual(["'self'"]);

  const probeURL = new URL('/__offline-csp-probe__', offlineOrigin).href;
  const protection = await page.evaluate(async (url) => {
    const violations: { effectiveDirective: string; blockedURI: string; disposition: string }[] = [];
    const observed = new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        document.removeEventListener('securitypolicyviolation', onViolation);
        resolve();
      };
      const onViolation = (event: SecurityPolicyViolationEvent) => {
        violations.push({ effectiveDirective: event.effectiveDirective, blockedURI: event.blockedURI, disposition: event.disposition });
        if (violations.some((entry) => entry.effectiveDirective === 'connect-src')
          && violations.some((entry) => ['script-src', 'script-src-elem'].includes(entry.effectiveDirective))) finish();
      };
      const timer = window.setTimeout(finish, 2_000);
      document.addEventListener('securitypolicyviolation', onViolation);
    });
    const inline = document.createElement('script');
    inline.textContent = 'document.documentElement.dataset.offlineCspProbe = "executed";';
    document.head.append(inline);
    inline.remove();
    const fetchRejected = fetch(url, { method: 'POST', body: 'synthetic-csp-probe' }).then(() => false, () => true);
    const [, rejected] = await Promise.all([observed, fetchRejected]);
    return { violations, fetchRejected: rejected, inlineExecuted: document.documentElement.dataset.offlineCspProbe === 'executed' };
  }, probeURL);
  await testInfo.attach('offline-build-csp.json', {
    body: Buffer.from(JSON.stringify(protection, null, 2)), contentType: 'application/json',
  });
  expect(protection.fetchRejected).toBe(true);
  expect(protection.inlineExecuted).toBe(false);
  expect(protection.violations).toContainEqual(expect.objectContaining({
    effectiveDirective: 'connect-src', blockedURI: probeURL, disposition: 'enforce',
  }));
  expect(protection.violations.some((entry) => ['script-src', 'script-src-elem'].includes(entry.effectiveDirective)
    && entry.blockedURI === 'inline' && entry.disposition === 'enforce')).toBe(true);
});
