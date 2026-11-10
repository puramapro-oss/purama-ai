import { test as base, expect } from '@playwright/test';
import { publicOrigin, publicSupabaseOrigin } from './environment';

type NetworkEvent = { method: string; origin: string; path: string; decision: string };

export const test = base.extend<{ publicNetwork: void }>({
  publicNetwork: [async ({ context, baseURL }, use, testInfo) => {
    expect(baseURL).toBe(publicOrigin);
    const events: NetworkEvent[] = [];
    const unexpected: NetworkEvent[] = [];
    await context.addInitScript(() => {
      // Returning anonymous visitor, without optional analytics consent.
      localStorage.setItem('purama_ai_intro_seen', '1');
      localStorage.setItem('cookie_consent', JSON.stringify({ essential: true, analytics: false, timestamp: Date.now() }));
    });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const event = { method, origin: url.origin, path: url.pathname, decision: '' };
      if (url.origin === publicOrigin && ['GET', 'HEAD'].includes(method)) {
        return route.continue();
      }
      if (url.origin === publicSupabaseOrigin) {
        const publicTable = /^\/rest\/v1\/(agents|concours|classement_mensuel|cross_promos)$/.test(url.pathname);
        if (method === 'GET' && publicTable) {
          events.push({ ...event, decision: 'simulated-public-read' });
          const body = request.headers().accept?.includes('vnd.pgrst.object') ? 'null' : '[]';
          return route.fulfill({ status: 200, contentType: 'application/json', body });
        }
        if (method === 'POST' && url.pathname === '/rest/v1/rpc/public_weekly_actions_count') {
          events.push({ ...event, decision: 'simulated-public-read-only-rpc' });
          return route.fulfill({ status: 200, contentType: 'application/json', body: '0' });
        }
      }
      if (method === 'GET' && url.origin === 'https://fonts.googleapis.com' && url.pathname === '/css2') {
        events.push({ ...event, decision: 'external-font-styles-replaced-with-empty-css' });
        return route.fulfill({ status: 200, contentType: 'text/css', body: '/* Offline public-site qualification. */' });
      }
      const blocked = { ...event, decision: 'blocked-unexpected-request' };
      events.push(blocked);
      unexpected.push(blocked);
      await route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      const blocked = { method: 'WebSocket', origin: url.origin, path: url.pathname, decision: 'blocked-unexpected-request' };
      events.push(blocked);
      unexpected.push(blocked);
      socket.close();
    });
    await use();
    await testInfo.attach('public-network', {
      body: Buffer.from(JSON.stringify({ externalRequestsForwarded: 0, events }, null, 2)),
      contentType: 'application/json',
    });
    expect(unexpected, 'Every provider mutation and unplanned external request must remain blocked').toEqual([]);
  }, { auto: true }],
});

export { expect };
