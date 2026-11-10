// Only the transport is substituted. Production auth context, social client,
// request scopes, components and response validation all execute unchanged.
const initial = window.__socialFixtureOptions ?? {};
const sessions = {
  'fixture-owner': { access_token: 'fixture-token', user: { id: 'fixture-owner' } },
  'fixture-other': { access_token: 'fixture-other-token', user: { id: 'fixture-other' } },
};
export const fixture = window.__socialFixture = {
  calls: [], published: [], responses: [], pending: {}, completed: [],
  plans: [...(initial.plans ?? [])], configs: {},
  session: initial.signedOut ? null : sessions['fixture-owner'],
};
export function setFixtureOwner(owner) {
  fixture.session = owner === null ? null : sessions[owner];
  if (owner !== null && !fixture.session) throw new Error('Unknown fixture owner');
  return fixture.session;
}
function ownerLabel(owner) { return owner === 'fixture-owner' ? 'A' : 'B'; }
function defaultConfig(owner) {
  return { user_id: owner, autopilot_enabled: false, auto_caption: false, auto_hashtags: false,
    default_platforms: ['instagram'], timezone: 'Europe/Paris', updated_at: '2026-11-10T00:00:00Z' };
}
function accounts(owner) {
  return [{ id: 'account-' + owner, user_id: owner, platform: 'instagram',
    zernio_account_id: 'provider-' + owner, zernio_profile_id: 'profile-' + owner,
    account_name: 'Compte social privé ' + ownerLabel(owner), account_username: null,
    is_active: true, publishing_verified_at: '2026-11-10T00:00:00Z',
    disconnect_pending: false, disconnect_completed_at: null,
    connected_at: '2026-11-10T00:00:00Z', metadata: {} }];
}
function history(owner) {
  return [{ id: 'history-' + owner, content_text: 'Publication privée ' + ownerLabel(owner),
    target_platforms: ['instagram'], status: 'published', scheduled_at: null,
    published_at: '2026-11-10T00:00:00Z', created_at: '2026-11-10T00:00:00Z',
    error_message: null, platform_results: [] }];
}
function publication(status) {
  return { success: status === 'published' || status === 'scheduled', status,
    post_id: 'fixture-post', retryable: false, caption_generated: false,
    platform_results: status === 'partial' ? [
      { platform: 'instagram', accountId: 'fixture-ig', status: 'published' },
      { platform: 'linkedin', accountId: 'fixture-li', status: 'failed' },
    ] : [],
    error: status === 'publish_unconfirmed' ? 'Résultat fournisseur à confirmer.' : undefined,
  };
}
function defaultResponse(name, method, owner, body, status) {
  if (name === 'agent-proxy' && method === 'POST') return {
    success: true, data: 'Résultat privé généré pour le compte ' + ownerLabel(owner) + '.',
  };
  if (name === 'social-accounts' && method === 'GET') return accounts(owner);
  if (name === 'social-publish' && method === 'GET') return history(owner);
  if (name === 'social-publish' && method === 'POST') return publication(status ?? 'published');
  if (name === 'social-autopilot-config') {
    fixture.configs[owner] ??= defaultConfig(owner);
    if (method === 'POST') fixture.configs[owner] = { ...fixture.configs[owner], ...body, user_id: owner };
    return structuredClone(fixture.configs[owner]);
  }
  if (name === 'social-connect' && method === 'POST') return { authUrl: 'https://fixture-provider.invalid/oauth' };
  throw new Error('Unexpected fixture function: ' + method + ' ' + name);
}
export const supabase = {
  // The real execution hook may look up the agent for usage logging. This test
  // catalog has no persisted agent row; the generation response remains real UI input.
  from: table => {
    if (table !== 'agents') throw new Error('Unexpected fixture table: ' + table);
    return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
  },
  auth: {
    getSession: async () => ({ data: { session: fixture.session }, error: null }),
    getUser: async () => ({ data: { user: fixture.session?.user ?? null }, error: null }),
  },
  functions: {
    invoke: async (name, options) => {
      const method = options?.method ?? 'POST';
      const headers = Object.fromEntries(new Headers(options?.headers));
      const token = headers.authorization?.replace(/^Bearer /, '') ?? fixture.session?.access_token;
      const owner = Object.values(sessions).find(value => value.access_token === token)?.user.id;
      if (!owner) return { data: null, error: new Error('Fixture authentication required') };
      const body = structuredClone(options?.body);
      fixture.calls.push({ name, method, owner, headers, body });
      const planIndex = fixture.plans.findIndex(plan => plan.name === name &&
        (!plan.method || plan.method === method) && (!plan.owner || plan.owner === owner));
      const plan = planIndex >= 0 ? fixture.plans.splice(planIndex, 1)[0] : null;
      const scenario = plan ?? (name === 'social-publish' && method === 'POST'
        ? fixture.responses.shift() ?? 'published' : {});
      const status = typeof scenario === 'string' ? scenario : scenario.status;
      const data = scenario.data ?? defaultResponse(name, method, owner, body, status);
      // Deliberately non-cooperative transport: a late response can still arrive
      // after AbortSignal fires, so production guards must make it inert.
      if (scenario.defer) await new Promise(resolve => { fixture.pending[scenario.defer] = resolve; });
      if (scenario.defer) fixture.completed.push(scenario.defer);
      if (status === 'network_lost' || scenario.error) return { data: null,
        error: new Error(scenario.error || 'Réponse réseau perdue après réception de la demande') };
      return { data, error: null };
    },
  },
};
