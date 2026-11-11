const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const project = path.resolve(__dirname, '..');
const routerRoot = path.dirname(require.resolve('expo-router/package.json'));
const routerRequire = createRequire(path.join(routerRoot, 'build/fork/getPathFromState.js'));
const queryPath = routerRequire.resolve('query-string');
const query = routerRequire('query-string');
const queryRequire = createRequire(queryPath);
const decoderPath = queryRequire.resolve('decode-uri-component');
const metroRoot = path.dirname(require.resolve('metro/package.json'));
const metroRequire = createRequire(path.join(metroRoot, 'src/Assets.js'));
const imagePath = metroRequire.resolve('image-size');
const metroAssets = require(path.join(metroRoot, 'src/Assets.js'));
const expoRequire = createRequire(require.resolve('expo/package.json'));
const configRoot = path.dirname(expoRequire.resolve('@expo/metro-config/package.json'));
const postcss = createRequire(path.join(configRoot, 'package.json'))('postcss');

function isolated(script, args = []) {
  const result = spawnSync(process.execPath, ['-e', script, ...args], {
    cwd: project, encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, `isolated parser did not finish: ${result.error?.code}`);
  assert.equal(result.signal, null, `isolated parser was terminated: ${result.signal}`);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('the real Router query dependency retains callable CommonJS exports', () => {
  assert.equal(typeof query.parse, 'function');
  assert.equal(typeof query.stringify, 'function');
  assert.equal(typeof queryRequire('decode-uri-component'), 'function');
  assert.deepEqual({ ...query.parse('name=%C3%89t%C3%A9+test&plus=%2B&tag=a&tag=b') },
    { name: 'Été test', plus: '+', tag: ['a', 'b'] });
  assert.equal(query.stringify({ z: 'Été test', a: '+' }, { sort: false }), 'z=%C3%89t%C3%A9%20test&a=%2B');
});

test('the real Router serializer keeps its named import contract', () => {
  const file = path.join(routerRoot, 'build/fork/getPathFromState-forks.js');
  const ownRequire = createRequire(file);
  const module = { exports: {} };
  // Only the unused native-UI entry is isolated. The installed Router module,
  // its import helper, query-string and matcher modules all execute unchanged.
  const load = name => name === '@react-navigation/native'
    ? { validatePathConfig() { throw new Error('unused native validation must not be called'); } }
    : ownRequire(name);
  vm.runInThisContext(`(function (module, exports, require) {\n${fs.readFileSync(file, 'utf8')}\n})`,
    { filename: file })(module, module.exports, load);
  assert.equal(module.exports.appendQueryAndHash('/agent', { name: 'Été + test', '#': 'section' }),
    '/agent?name=%C3%89t%C3%A9%20%2B%20test#section');
});

test('malformed query encodings retain their text and type errors are not hidden', () => {
  const decode = queryRequire('decode-uri-component');
  assert.equal(decode('%C3%A9%zz'), 'é%zz');
  assert.throws(() => decode({ value: 'x' }), TypeError);
  assert.equal(query.parse('value=%C3%A9%zz').value, 'é%zz');
});

test('GHSA-qr28-fpjm-wq7f: distinct malformed percent runs finish in an isolated process', () => {
  const result = isolated(`
    const query = require(process.argv[1]);
    let input = '';
    for (let i = 0; i < 32000; i++) {
      input += '%' + Math.floor(i / 256).toString(16).padStart(2, '0')
        + '%' + (i % 256).toString(16).padStart(2, '0') + 'x';
    }
    const parsed = query.parse('value=' + input + '%zz');
    process.stdout.write(JSON.stringify({ type: typeof parsed.value, suffix: parsed.value.slice(-3) }));
  `, [queryPath]);
  assert.deepEqual(result, { type: 'string', suffix: '%zz' });
});

test('Metro reads real PNG dimensions from both Buffer and filesystem paths', async () => {
  const asset = path.join(project, 'assets/icon.png');
  assert.deepEqual(metroAssets.getAssetSize('png', fs.readFileSync(asset), asset), { width: 1024, height: 1024 });
  const actual = await metroAssets.getAssetData(asset, 'assets/icon.png', [], 'ios', '/assets');
  assert.equal(actual.width, 1024);
  assert.equal(actual.height, 1024);
  assert.equal(actual.type, 'png');
  assert.deepEqual(actual.files, [asset]);
});

test('Metro image dependency preserves file/type failures and the header read bound', () => {
  const size = metroRequire('image-size');
  assert.equal(typeof size, 'function');
  assert.throws(() => size(path.join(os.tmpdir(), 'purama-missing-image-20261111.png')), { code: 'ENOENT' });
  assert.throws(() => size({}), TypeError);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'purama-image-bound-'));
  const file = path.join(temp, 'large.png');
  const descriptor = fs.openSync(file, 'w');
  fs.writeSync(descriptor, fs.readFileSync(path.join(project, 'assets/icon.png')));
  fs.ftruncateSync(descriptor, 2 * 1024 * 1024);
  fs.closeSync(descriptor);
  const read = fs.readSync;
  let largestRead = 0;
  fs.readSync = function (fd, buffer, offset, length, position) {
    largestRead = Math.max(largestRead, length);
    return read.call(this, fd, buffer, offset, length, position);
  };
  try {
    assert.equal(size(file).width, 1024);
    assert.ok(largestRead > 0 && largestRead <= 512 * 1024);
  } finally {
    fs.readSync = read;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('GHSA-w3rx-r6r6-pgpr: a zero-length ICNS block is rejected without hanging', () => {
  const result = isolated(`
    const size = require(process.argv[1]);
    const input = Buffer.alloc(16);
    input.write('icns'); input.writeUInt32BE(16, 4); input.write('ic07', 8);
    let rejected = false;
    try { size(input); } catch { rejected = true; }
    process.stdout.write(JSON.stringify({ rejected }));
  `, [imagePath]);
  assert.deepEqual(result, { rejected: true });
});

test('PostCSS through Expo Metro does not disclose a map outside the CSS directory', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'purama-postcss-map-'));
  const css = path.join(temp, 'css'); fs.mkdirSync(css);
  const marker = 'PURAMA_SYNTHETIC_PRIVATE_SOURCE';
  fs.writeFileSync(path.join(temp, 'private.map'), JSON.stringify({
    version: 3, file: 'generated.css', sources: ['private.css'], sourcesContent: [marker], names: [], mappings: 'AAAA',
  }));
  try {
    const result = await postcss().process('a { color: red }\n/*# sourceMappingURL=../private.map */',
      { from: path.join(css, 'input.css'), to: path.join(css, 'output.css') });
    assert.ok(result.css.includes('color: red'));
    assert.equal(result.map?.toString().includes(marker) ?? false, false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
