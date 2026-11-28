// Route selection only: the fixture exports below are mocks, never native evidence.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const Renderer = require('react-test-renderer');

global.IS_REACT_ACT_ENVIRONMENT = true;

function loadScreen(env, failDigest = false, loggerThrows = false) {
  const imports = [], calls = [], diagnostics = [];
  const externals = {
    react: React,
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { ScrollView: 'ScrollView', Text: 'Text', View: 'View' },
    '../lib/iao-native-qualification': { runIaoNativeQualification: async onStatus => {
      calls.push('offline'); onStatus('synthetic offline status');
      return { schema: 1, status: 'PASS', phase: 'prepared', synthetic: true };
    } },
    '../lib/iao-digest-qualification': { runIaoDigestQualification: async onStatus => {
      calls.push('digest'); onStatus('synthetic digest status');
      if (failDigest) throw failDigest === true ? new Error('synthetic fixture rejection') : failDigest;
      return { schema: 1, status: 'PASS', synthetic: true };
    } },
  };
  const file = path.resolve(__dirname, '../app/iao-qualification.tsx');
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} };
  const requireLocal = name => {
    imports.push(name);
    if (Object.hasOwn(externals, name)) return externals[name];
    throw new Error(`Unexpected screen import: ${name}`);
  };
  const console = { info(...values) {
    if (loggerThrows) throw new Error('synthetic unavailable logger');
    diagnostics.push(values);
  } };
  vm.runInThisContext(`(function(require,module,exports,process,console){${code}\n})`, { filename: file })(
    requireLocal, module, module.exports, { env }, console);
  return { component: module.exports.default, imports, calls, diagnostics };
}

async function renderScreen(loaded, assertions) {
  let renderer;
  try {
    await Renderer.act(async () => { renderer = Renderer.create(React.createElement(loaded.component)); });
    assertions(JSON.stringify(renderer.toJSON()));
  } finally {
    if (renderer) await Renderer.act(async () => renderer.unmount());
  }
}

for (const flag of [undefined, '', '0', 'true', '01']) {
  test(`normal route refuses non-exact digest flag ${String(flag)} without importing either fixture`, async () => {
    const loaded = loadScreen({ EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION: flag });
    await renderScreen(loaded, text => assert.ok(text.includes('n’est pas disponible')));
    assert.deepEqual(loaded.calls, []);
    assert.deepEqual(loaded.diagnostics, []);
    assert.deepEqual(loaded.imports.sort(), ['react', 'react/jsx-runtime', 'react-native'].sort());
  });
}

test('the original offline build selects only the existing Android fixture', async () => {
  const loaded = loadScreen({ EXPO_PUBLIC_PURAMA_OFFLINE_QUALIFICATION: '1' });
  await renderScreen(loaded, text => assert.ok(text.includes('synthetic offline status')));
  assert.deepEqual(loaded.calls, ['offline']);
  assert.deepEqual(loaded.diagnostics, []);
  assert.ok(!loaded.imports.includes('../lib/iao-digest-qualification'));
});

test('the digest build selects only the digest fixture in the existing route', async () => {
  const loaded = loadScreen({ EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION: '1' });
  await renderScreen(loaded, text => assert.ok(text.includes('synthetic digest status')));
  assert.deepEqual(loaded.calls, ['digest']);
  assert.deepEqual(loaded.diagnostics, [
    ['PURAMA_DIGEST_QUALIFICATION', 'route', 'mounted'],
    ['PURAMA_DIGEST_QUALIFICATION', 'status', 'synthetic digest status'],
    ['PURAMA_DIGEST_QUALIFICATION', 'receipt', 'PASS'],
  ]);
  assert.ok(!loaded.imports.includes('../lib/iao-native-qualification'));
});

test('simultaneous exact flags refuse both fixtures before any import', async () => {
  const loaded = loadScreen({ EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION: '1', EXPO_PUBLIC_PURAMA_OFFLINE_QUALIFICATION: '1' });
  await renderScreen(loaded, text => assert.ok(text.includes('configuration') || text.includes('Configuration')));
  assert.deepEqual(loaded.calls, []);
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(loaded.imports.sort(), ['react', 'react/jsx-runtime', 'react-native'].sort());
});

test('a non-exact digest flag does not block the original offline fixture', async () => {
  const loaded = loadScreen({ EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION: 'true', EXPO_PUBLIC_PURAMA_OFFLINE_QUALIFICATION: '1' });
  await renderScreen(loaded, () => {});
  assert.deepEqual(loaded.calls, ['offline']);
});

test('a non-exact offline flag does not enable the Android fixture in a digest build', async () => {
  const loaded = loadScreen({ EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION: '1', EXPO_PUBLIC_PURAMA_OFFLINE_QUALIFICATION: 'true' });
  await renderScreen(loaded, () => {});
  assert.deepEqual(loaded.calls, ['digest']);
  assert.ok(!loaded.imports.includes('../lib/iao-native-qualification'));
});

test('a digest fixture rejection stays unavailable without trying the Android fixture', async () => {
  const loaded = loadScreen({ EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION: '1' }, true);
  await renderScreen(loaded, text => assert.ok(text.includes('Qualification native indisponible.')));
  assert.deepEqual(loaded.calls, ['digest']);
  assert.ok(!loaded.imports.includes('../lib/iao-native-qualification'));
  assert.deepEqual(loaded.diagnostics.at(-1), ['PURAMA_DIGEST_QUALIFICATION', 'rejected', 'Error']);
});

test('early or receipt-write rejection records its bounded code without the error message', async () => {
  const loaded = loadScreen({ EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION: '1' },
    { code: 'ERR_FILE_WRITE', name: 'Error', message: 'sensitive synthetic contents must not be logged' });
  await renderScreen(loaded, text => assert.ok(text.includes('Qualification native indisponible.')));
  assert.deepEqual(loaded.diagnostics.at(-1), ['PURAMA_DIGEST_QUALIFICATION', 'rejected', 'ERR_FILE_WRITE']);
  assert.ok(!JSON.stringify(loaded.diagnostics).includes('sensitive'));
});

test('unbounded, control-character and exceptional diagnostic codes remain unclassified', async () => {
  for (const failure of [{ code: 'x'.repeat(81) }, { code: 'bad\ncode' },
    { get code() { throw new Error('synthetic getter'); } }]) {
    const loaded = loadScreen({ EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION: '1' }, failure);
    await renderScreen(loaded, text => assert.ok(text.includes('Qualification native indisponible.')));
    assert.deepEqual(loaded.diagnostics.at(-1), ['PURAMA_DIGEST_QUALIFICATION', 'rejected', 'unclassified']);
  }
});

test('diagnostic logger failures change neither successful nor rejected qualification behavior', async () => {
  for (const failure of [false, true]) {
    const loaded = loadScreen({ EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION: '1' }, failure, true);
    await renderScreen(loaded, text => assert.ok(text.includes(failure
      ? 'Qualification native indisponible.' : 'synthetic digest status')));
    assert.deepEqual(loaded.calls, ['digest']);
    assert.ok(!loaded.imports.includes('../lib/iao-native-qualification'));
  }
});
