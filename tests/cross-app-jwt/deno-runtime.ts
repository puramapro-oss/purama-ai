import { cases, evaluateCase } from './cases.mjs';

// Import the real Edge module after setting only fixture configuration.
// The command grants these three environment names, no network or process access.
Deno.env.set('DOCUSEAL_API_URL', 'https://docuseal.fixture.invalid');
Deno.env.set('DOCUSEAL_API_TOKEN', 'fixture-unused-document-token');
Deno.env.set('DOCUSEAL_WEBHOOK_SECRET', 'fixture-unused-webhook-token');
const { verifyCrossAppJwt } = await import('../../supabase/functions/_shared/docuseal.ts');

Deno.test('native JWT fixture denies network and process execution', async () => {
  for (const name of ['net', 'run'] as const) {
    if ((await Deno.permissions.query({ name })).state !== 'denied') {
      throw new Error(`Expected ${name} permission to be denied`);
    }
  }
});

for (const item of cases) {
  Deno.test(`edge: ${item.name}`, async () => {
    const result = await evaluateCase(verifyCrossAppJwt, item);
    if (result.accepted !== item.accepted) {
      throw new Error(`${item.name}: expected acceptance ${item.accepted}, received ${result.accepted}`);
    }
    if (item.accepted && (result.payload.aud !== 'purama-contracts-hub' || result.payload.app_slug !== 'fixture-app')) {
      throw new Error('Accepted token must return its verified application claims');
    }
  });
}
