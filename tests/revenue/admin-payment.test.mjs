import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

let vite;
before(async () => {
  const fixture = fileURLToPath(new URL('./admin-fixture.ts', import.meta.url));
  vite = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: false,
    envDir: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null },
    resolve: { alias: Object.fromEntries([
      '@tanstack/react-query', '@/integrations/supabase/client', '@/hooks/useAuth', 'sonner',
    ].map((name) => [name, fixture])) },
  });
});
after(async () => { await vite?.close(); });

test('real admin mutation rejects paid without any database write or success announcement', async () => {
  // Vite supplies import.meta.env exactly as it does for the application. Only
  // hook infrastructure is substituted; the production mutation executes here.
  const { useInfluencerAdmin, INFLUENCER_PAYMENT_UNAVAILABLE } = await vite.ssrLoadModule('/src/hooks/useInfluencer.ts');
  const { adminFixture } = await vite.ssrLoadModule('/tests/revenue/admin-fixture.ts');
  const admin = useInfluencerAdmin();
  for (const id of ['legacy_commission', 'another_commission']) {
    await assert.rejects(admin.markCommissionPaid.mutateAsync(id), {
      message: INFLUENCER_PAYMENT_UNAVAILABLE,
    });
  }
  assert.equal(adminFixture.databaseCalls, 0);
  assert.deepEqual(adminFixture.successMessages, []);
  assert.equal(adminFixture.invalidations, 0);
  assert.deepEqual(adminFixture.errorMessages, Array.from({ length: 2 }, () => ({
    title: 'Paiement non confirmé', description: INFLUENCER_PAYMENT_UNAVAILABLE,
  })));
});
