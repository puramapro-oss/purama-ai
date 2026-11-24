import { test as base, expect } from '@playwright/test';

const localOrigin = 'http://127.0.0.1:4198';
type NetworkEvent = { method: string; origin: string; path: string; decision: string };

export const test = base.extend<{ workshopNetwork: void }>({
  workshopNetwork: [async ({ context, browser, baseURL }, use, testInfo) => {
    expect(baseURL).toBe(localOrigin);
    const events: NetworkEvent[] = [];
    const unexpected: NetworkEvent[] = [];
    // Per-page fixture routes run first. Unhandled POSTs must never reach a real backend.
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === localOrigin && ['GET', 'HEAD'].includes(request.method())) return route.continue();
      if (request.method() === 'GET' && url.origin === 'https://fonts.googleapis.com' && url.pathname === '/css2') {
        events.push({ method: 'GET', origin: url.origin, path: url.pathname, decision: 'external-font-styles-replaced-with-empty-css' });
        return route.fulfill({ status: 200, contentType: 'text/css', body: '/* Offline workshop qualification. */' });
      }
      const blocked = { method: request.method(), origin: url.origin, path: url.pathname, decision: 'blocked-unexpected-request' };
      events.push(blocked); unexpected.push(blocked);
      await route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      if (url.origin === 'ws://127.0.0.1:4198' && url.pathname === '/') {
        events.push({ method: 'WebSocket', origin: url.origin, path: url.pathname, decision: 'local-vite-hmr' });
        socket.connectToServer(); return;
      }
      const blocked = { method: 'WebSocket', origin: url.origin, path: url.pathname, decision: 'blocked-unexpected-request' };
      events.push(blocked); unexpected.push(blocked); socket.close();
    });
    await use();
    await testInfo.attach('workshop-network-and-runtime', {
      body: Buffer.from(JSON.stringify({ externalRequestsForwarded: 0, platform: process.platform,
        browser: browser.browserType().name(), version: browser.version(), viewport: testInfo.project.use.viewport, events }, null, 2)),
      contentType: 'application/json',
    });
    expect(unexpected, 'Only local Vite resources may reach the network; workshop mutations stay simulated').toEqual([]);
  }, { auto: true }],
});

export { expect };
export type { Page } from '@playwright/test';
