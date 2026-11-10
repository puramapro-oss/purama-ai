// Only the transport is substituted; the real social client and button run.
window.__socialFixture = { calls: [], published: [], responses: [] };
export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: { access_token: 'fixture-token', user: { id: 'fixture-owner' } } }, error: null }),
    getUser: async () => ({ data: { user: { id: 'fixture-owner' } }, error: null }),
  },
  functions: {
    invoke: async (name, options) => {
      const fixture = window.__socialFixture;
      fixture.calls.push({ name, body: structuredClone(options?.body) });
      if (name === 'social-autopilot-config') return { data: { autopilot_enabled: false }, error: null };
      if (name !== 'social-publish') throw new Error('Unexpected fixture function: ' + name);
      const scenario = fixture.responses.shift() ?? 'published';
      if (scenario === 'network_lost') return { data: null, error: new Error('Réponse réseau perdue après réception de la demande') };
      const status = scenario;
      return { error: null, data: {
        success: status === 'published' || status === 'scheduled', status,
        post_id: 'fixture-post', retryable: false, caption_generated: false,
        platform_results: status === 'partial' ? [
          { platform: 'instagram', accountId: 'fixture-ig', status: 'published' },
          { platform: 'linkedin', accountId: 'fixture-li', status: 'failed' },
        ] : [],
        error: status === 'publish_unconfirmed' ? 'Résultat fournisseur à confirmer.' : undefined,
      } };
    },
  },
};
