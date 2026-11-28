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

function loadScreen(env, failDigest = false) {
  const imports = [], calls = [];
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
      if (failDigest) throw new Error('synthetic fixture rejection');
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
  vm.runInThisContext(`(function(require,module,exports,process){${code}\n})`, { filename: file })(
    requireLocal, module, module.exports, { env });
  return { component: module.exports.default, imports, calls };
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
    assert.deepEqual(loaded.imports.sort(), ['react', 'react/jsx-runtime', 'react-native'].sort());
  });
}

test('the original offline build selects only the existing Android fixture', async () => {
  const loaded = loadScreen({ EXPO_PUBLIC_PURAMA_OFFLINE_QUALIFICATION: '1' });
  await renderScreen(loaded, text => assert.ok(text.includes('synthetic offline status')));
  assert.deepEqual(loaded.calls, ['offline']);
  assert.ok(!loaded.imports.includes('../lib/iao-digest-qualification'));
});

test('the digest build selects only the digest fixture in the existing route', async () => {
  const loaded = loadScreen({ EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION: '1' });
  await renderScreen(loaded, text => assert.ok(text.includes('synthetic digest status')));
  assert.deepEqual(loaded.calls, ['digest']);
  assert.ok(!loaded.imports.includes('../lib/iao-native-qualification'));
});

test('simultaneous exact flags refuse both fixtures before any import', async () => {
  const loaded = loadScreen({ EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION: '1', EXPO_PUBLIC_PURAMA_OFFLINE_QUALIFICATION: '1' });
  await renderScreen(loaded, text => assert.ok(text.includes('configuration') || text.includes('Configuration')));
  assert.deepEqual(loaded.calls, []);
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
});
