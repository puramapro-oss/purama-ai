// Guards only: no simulated result in these tests is native qualification evidence.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const Renderer = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;

function load(relative, flag, external = {}) {
  const file = path.resolve(__dirname, '..', relative); const imports = [];
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} };
  const requireLocal = name => {
    imports.push(name);
    if (Object.hasOwn(external, name)) return external[name];
    throw new Error(`Disabled qualification attempted import: ${name}`);
  };
  vm.runInThisContext(`(function(require,module,exports,process){${source}\n})`, { filename: file })(
    requireLocal, module, module.exports, { env: { EXPO_PUBLIC_PURAMA_OFFLINE_QUALIFICATION: flag } });
  return { api: module.exports, imports };
}

for (const flag of [undefined, '', '0', 'true', '01']) test(`qualification harness refuses non-exact flag ${String(flag)} without any native/storage import`, async () => {
  const loaded = load('lib/iao-native-qualification.ts', flag);
  await assert.rejects(loaded.api.runIaoNativeQualification(), { code: 'qualification-disabled' });
  assert.deepEqual(loaded.imports, []);
});

test('the normal-build QA route mounts without importing the qualification module or opening fixtures', async () => {
  const loaded = load('app/iao-qualification.tsx', undefined, {
    react: React, 'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { ScrollView: 'ScrollView', Text: 'Text', View: 'View' },
  });
  let renderer;
  await Renderer.act(async () => { renderer = Renderer.create(React.createElement(loaded.api.default)); });
  assert.ok(JSON.stringify(renderer.toJSON()).includes('n’est pas disponible'));
  assert.deepEqual(loaded.imports.sort(), ['react', 'react-native', 'react/jsx-runtime'].sort());
  await Renderer.act(async () => renderer.unmount());
});
