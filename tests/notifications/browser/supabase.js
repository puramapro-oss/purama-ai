/* Synthetic transport only. Product hooks, React Query, components and Sonner remain real. */
const scenario = window.__notificationScenario ?? {};
const rows = structuredClone(scenario.rows ?? {});
const preferences = structuredClone(scenario.preferences ?? {});
const rules = [...(scenario.rules ?? [])];
const calls = [];
const channels = [];
const held = new Map();
let sequence = 0;

function defaultPreferences(owner) {
  return { id: `preferences-${owner}`, user_id: owner, email_enabled: true,
    task_completed_enabled: true, question_enabled: true, daily_report_enabled: true,
    alert_enabled: true, created_at: '2026-11-27T00:00:00Z', updated_at: '2026-11-27T00:00:00Z' };
}

function resultFor(call) {
  const owner = call.filters.find(([key]) => key === 'user_id')?.[1] ?? call.value?.user_id;
  const id = call.filters.find(([key]) => key === 'id')?.[1];
  if (call.table === 'notifications') {
    const current = rows[owner] ?? [];
    if (call.action === 'select') return { data: structuredClone(current), error: null };
    const affected = current.filter(row => (!id || row.id === id) && (!call.or || row.read !== true));
    if (call.action === 'update') {
      for (const row of affected) Object.assign(row, call.value);
      return { data: structuredClone(call.single ? affected[0] ?? null : affected), error: null };
    }
    if (call.action === 'delete') {
      rows[owner] = current.filter(row => !affected.includes(row));
      return { data: structuredClone(call.single ? affected[0] ?? null : affected), error: null };
    }
  }
  if (call.table === 'notification_preferences') {
    if (call.action === 'select') return { data: structuredClone(preferences[owner] ?? null), error: null };
    if (call.action === 'upsert') {
      preferences[owner] = { ...(preferences[owner] ?? defaultPreferences(owner)), ...call.value };
      return { data: structuredClone(preferences[owner]), error: null };
    }
  }
  throw new Error(`Unexpected fixture operation: ${call.table}/${call.action}`);
}

function builder(table) {
  const call = { id: ++sequence, table, action: 'select', filters: [], value: null, single: false, columns: null, or: null };
  let pending;
  const execute = () => {
    if (pending) return pending;
    calls.push(call);
    const ruleIndex = rules.findIndex(rule => rule.table === table && rule.action === call.action);
    const rule = ruleIndex === -1 ? null : rules.splice(ruleIndex, 1)[0];
    if (rule?.mode === 'hold') pending = new Promise(resolve => held.set(call.id, { call, resolve }));
    else if (rule?.mode === 'error') pending = Promise.resolve({ data: null, error: { message: 'Synthetic unavailable transport' } });
    else pending = Promise.resolve(resultFor(call));
    return pending;
  };
  const chain = {
    select(columns) { call.columns = columns; return chain; },
    eq(key, value) { call.filters.push([key, value]); return chain; },
    order() { return chain; },
    or(value) { call.or = value; return chain; },
    update(value) { call.action = 'update'; call.value = value; return chain; },
    delete() { call.action = 'delete'; return chain; },
    upsert(value, options) { call.action = 'upsert'; call.value = value; call.options = options; return chain; },
    single() { call.single = true; return execute(); },
    maybeSingle() { call.single = true; return execute(); },
    then(resolve, reject) { return execute().then(resolve, reject); },
  };
  return chain;
}

export const supabase = {
  from: builder,
  channel(name) {
    const channel = { id: ++sequence, name, removed: false, callbacks: [] };
    channels.push(channel);
    const api = {
      on(event, filter, callback) { channel.callbacks.push({ event, filter, callback }); return api; },
      subscribe() { return api; },
      __channel: channel,
    };
    return api;
  },
  removeChannel(channel) { channel.__channel.removed = true; return Promise.resolve('ok'); },
};

window.__notificationFixture = {
  snapshot: () => ({ calls: structuredClone(calls), channels: channels.map(channel => ({
    id: channel.id, name: channel.name, removed: channel.removed,
    filters: channel.callbacks.map(entry => entry.filter),
  })), held: [...held.keys()] }),
  queue: rule => rules.push(rule),
  setRows: (owner, value) => { rows[owner] = structuredClone(value); },
  setPreferences: (owner, value) => { preferences[owner] = structuredClone(value); },
  emit: (id, row) => {
    const channel = channels.find(candidate => candidate.id === id);
    if (!channel) throw new Error(`Unknown fixture channel ${id}`);
    for (const entry of channel.callbacks) entry.callback({ new: structuredClone(row) });
  },
  resolve: (id, value) => {
    const item = held.get(id);
    if (!item) throw new Error(`Unknown pending fixture request ${id}`);
    held.delete(id);
    item.resolve(value ?? resultFor(item.call));
  },
};
