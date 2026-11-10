export const principal = id => ({ id, email: id.toLowerCase() + '@example.test' });
export const contractId = (id, index) => {
  const digit = id === 'A' ? (index === 1 ? '3' : '4') : (index === 1 ? '5' : '6');
  return digit.repeat(8) + '-' + digit.repeat(4) + '-4' + digit.repeat(3) + '-8' + digit.repeat(3) + '-' + digit.repeat(12);
};
export function contracts(id) {
  return [1, 2].map(index => ({
    id: contractId(id, index),
    user_id: id,
    app_slug: 'fixture',
    template_slug: 'CONTRACT_' + id + '_' + (index === 1 ? 'ONE' : 'TWO'),
    status: 'signed',
    docuseal_submission_id: index,
    commission_rate: null,
    metadata: { signer_email: id.toLowerCase() + '@example.test' },
    created_at: '2026-11-10T00:00:00Z',
    signed_at: '2026-11-10T00:01:00Z',
    ots_block_height: null,
    ots_btc_timestamp: null,
    ots_proof: 'synthetic-proof',
  }));
}

window.__queries = [];
window.__sessions = [];
window.__pendingOts = [];
window.__otsCalls = [];
window.__notices = [];
window.__deferSession = false;
let sequence = 0;

export const supabase = {
  schema() { return this; },
  from(table) {
    const owner = window.__principal;
    const filters = {};
    const execute = () => {
      window.__queries.push({ table, owner, filters: { ...filters } });
      if (table === 'user_roles') return { data: filters.user_id ? { role: 'admin' } : null, error: null };
      if (table === 'contracts') return { data: contracts(owner), error: null };
      throw new Error('Unexpected database table in the closed fixture: ' + table);
    };
    const query = {
      select() { return query; },
      eq(key, value) { filters[key] = value; return query; },
      order() { return query; },
      limit() { return query; },
      maybeSingle() { return Promise.resolve(execute()); },
      then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
    };
    return query;
  },
  auth: {
    getSession() {
      const owner = window.__principal;
      const result = { data: { session: { user: principal(owner), access_token: 'fixture-access-' + owner } } };
      if (!window.__deferSession) return Promise.resolve(result);
      return new Promise(resolve => { window.__sessions.push({ owner, resolve: () => resolve(result) }); });
    },
  },
};

window.__resolveSession = () => {
  const pending = window.__sessions.shift();
  if (!pending) throw new Error('No suspended session read');
  pending.resolve();
};
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.origin !== 'https://supabase.fixture.invalid' || url.pathname !== '/functions/v1/contracts-ots-verify') {
    throw new Error('Unexpected fetch in the closed OTS browser fixture');
  }
  const id = ++sequence;
  const request = {
    id,
    contract: url.searchParams.get('id'),
    caller: new Headers(init?.headers).get('Authorization')?.replace('Bearer fixture-access-', ''),
  };
  window.__otsCalls.push(request);
  return new Promise(resolve => { window.__pendingOts.push({ ...request, resolve }); });
};
window.__resolveOts = (id, response) => {
  const index = window.__pendingOts.findIndex(request => request.id === id);
  if (index < 0) throw new Error('Unknown suspended OTS request');
  const [pending] = window.__pendingOts.splice(index, 1);
  pending.resolve(new Response(JSON.stringify(response.body), {
    status: response.status,
    headers: { 'Content-Type': 'application/json' },
  }));
};
