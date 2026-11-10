import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFounderDashboard, loadFounderDashboard, dashboardMetricLabel } from '../../src/lib/founder-dashboard.ts';

function snapshot() {
  return {
    version: 1, scope: 'purama_ai', observedAt: '2026-11-10T08:00:00.000Z',
    metrics: {
      profiles: { status: 'available', value: 0 },
      activeSubscriptions: { status: 'available', value: 2 },
      enabledAgents: { status: 'unavailable', value: null },
    },
    recentProfiles: { status: 'available', items: [] },
  };
}

test('zéro confirmé et source indisponible restent distincts', () => {
  const result = decodeFounderDashboard(snapshot());
  assert.equal(dashboardMetricLabel(result.metrics.profiles), '0');
  assert.equal(dashboardMetricLabel(result.metrics.enabledAgents), '—');
  assert.equal(dashboardMetricLabel(undefined), '—');
});

test('rejette les valeurs invalides et ne les transforme pas en zéro', () => {
  for (const value of [-1, 1.5, '12', null, undefined, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const data = snapshot(); data.metrics.profiles.value = value;
    assert.throws(() => decodeFounderDashboard(data), /ne sont pas vérifiables/);
  }
});

test('rejette une métrique indisponible munie d’un nombre', () => {
  const data = snapshot(); data.metrics.enabledAgents.value = 0;
  assert.throws(() => decodeFounderDashboard(data));
});

test('refuse les schémas et périmètres inconnus', () => {
  for (const change of [{ version: 2 }, { scope: 'all_companies' }, { observedAt: 'hier' }, { metrics: null }, { recentProfiles: [] }]) {
    assert.throws(() => decodeFounderDashboard({ ...snapshot(), ...change }));
  }
});

test('projette les profils sans email ni attribut privilégié', () => {
  const data = snapshot();
  data.recentProfiles.items.push({ id: 'profile-1', full_name: '<script>test</script>', created_at: null, email: 'private@example.test', role: 'admin' });
  const result = decodeFounderDashboard(data);
  assert.deepEqual(Object.keys(result.recentProfiles.items[0]).sort(), ['created_at', 'full_name', 'id']);
  assert.equal(JSON.stringify(result).includes('private@example.test'), false);
});

test('refuse doublons et listes excessives', () => {
  const data = snapshot();
  data.recentProfiles.items = [{ id: 'one', full_name: null, created_at: null }, { id: 'one', full_name: null, created_at: null }];
  assert.throws(() => decodeFounderDashboard(data));
  data.recentProfiles.items = Array.from({ length: 11 }, (_, i) => ({ id: String(i), full_name: null, created_at: null }));
  assert.throws(() => decodeFounderDashboard(data));
});

test('refuse dates invalides et profils cachés sous un état indisponible', () => {
  const data = snapshot();
  data.recentProfiles.items.push({ id: 'one', full_name: null, created_at: 'not-a-date' });
  assert.throws(() => decodeFounderDashboard(data));
  data.recentProfiles.items[0].created_at = null;
  data.recentProfiles.status = 'unavailable';
  assert.throws(() => decodeFounderDashboard(data));
});

test('lecture en GET avec signal d’annulation et délai borné', async () => {
  const controller = new AbortController();
  const result = await loadFounderDashboard(async (options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.signal, controller.signal);
    assert.equal(options.timeout, 10000);
    return { data: snapshot(), error: null };
  }, controller.signal);
  assert.equal(result.metrics.profiles.value, 0);
});

for (const [status, message] of [[401, /session/], [403, /refusé/], [429, /minute/], [503, /pas encore disponible/], [500, /ne répond pas/]]) {
  test('erreur HTTP ' + status + ' sans détail interne', async () => {
    const signal = new AbortController().signal;
    await assert.rejects(
      loadFounderDashboard(async () => ({ data: null, error: { context: { status }, message: 'SECRET_DATABASE_VALUE' } }), signal),
      (error) => message.test(error.message) && !error.message.includes('SECRET_DATABASE_VALUE'),
    );
  });
}

test('erreur réseau assainie', async () => {
  await assert.rejects(loadFounderDashboard(async () => { throw new Error('Bearer secret'); }, new AbortController().signal),
    (error) => error.message.includes('ne répond pas') && !error.message.includes('secret'));
});

test('une lecture annulée avant son départ ne contacte pas le serveur', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(loadFounderDashboard(async () => { calls++; return { data: snapshot(), error: null }; }, controller.signal),
    { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('une réponse tardive après annulation est ignorée', async () => {
  const controller = new AbortController();
  await assert.rejects(loadFounderDashboard(async () => {
    controller.abort(); return { data: snapshot(), error: null };
  }, controller.signal), { name: 'AbortError' });
});

test('une erreur de source n’affiche pas une fausse liste vide confirmée', () => {
  const data = snapshot(); data.recentProfiles = { status: 'unavailable', items: [] };
  const result = decodeFounderDashboard(data);
  assert.equal(result.recentProfiles.status, 'unavailable');
});
