// The real screen is transpiled here. React scheduling, WebView events and the
// native bridge boundary are deterministic doubles, not device qualification.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const origin = 'https://one.example.invalid';
const url = `${origin}/accessible-pour-moi`;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const compile = file => ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const bridgeApi = {};
new Function('exports', 'require', compile('lib/accessibility-one-bridge.ts'))(bridgeApi, name => { throw new Error(`Unexpected bridge import ${name}`); });
const screenSource = compile('app/accessible-one.tsx');

function harness(t, { configuredOrigin = origin } = {}) {
  const slots = [], effects = [], timers = new Map(), appListeners = new Set();
  const h = { bridges: [], injections: [], updates: 0, authorizationClears: 0, backs: 0, pushes: [], replacements: [], timers };
  let cursor = 0, nextTimer = 0, focusCleanup;
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, i) => value === b[i]);
  const react = {
    useState(value) {
      const i = cursor++; if (!(i in slots)) slots[i] = value;
      return [slots[i], next => { h.updates++; slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
    },
    useRef(value) { const i = cursor++; if (!(i in slots)) slots[i] = { current: value }; return slots[i]; },
    useCallback(fn, deps) {
      const i = cursor++; if (!slots[i] || !equal(slots[i].deps, deps)) slots[i] = { fn, deps };
      return slots[i].fn;
    },
    useEffect(fn, deps) {
      const i = cursor++, previous = slots[i];
      if (!previous || !equal(previous.deps, deps)) {
        const effect = { deps }; slots[i] = effect;
        effects.push(() => { previous?.cleanup?.(); effect.cleanup = fn(); });
      }
    },
  };
  const AppState = { currentState: 'active', addEventListener(type, callback) {
    assert.equal(type, 'change'); appListeners.add(callback); return { remove: () => appListeners.delete(callback) };
  } };
  const native = { version: 1, subscribe: () => () => {}, handshake() {}, send() {}, close() {} };
  const jsx = (type, props, key) => ({ type, props, key });
  const imports = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { AppState, Linking: { openURL: async () => {} }, Platform: { OS: 'android' },
      Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: value => value } },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    'expo-router': { router: { back: () => h.backs++, push: route => h.pushes.push(route), replace: route => h.replacements.push(route) },
      useFocusEffect(callback) {
        const saved = react.useRef(null);
        if (saved.current !== callback) { saved.current = callback; focusCleanup = callback(); }
      } },
    'react-native-webview': { WebView: 'WebView' },
    '@/modules/purama-accessibility-watch': {
      createNativeWatchHost: () => native, createNativeWatchChallenge: () => 'test-native-challenge',
      clearWatchAuthorization: async () => { h.authorizationClears++; await h.clearAuthorizationEffect?.(); },
      subscribeWatchStatus: callback => { h.nativeStatus = callback; return () => { h.nativeStatus = undefined; }; },
    },
    '@/lib/accessibility-one-bridge': { ...bridgeApi,
      createOneWebBridge(host, options) {
        assert.equal(host, native);
        const bridge = { options, received: [], closeCalls: 0,
          receive: async (data, sourceUrl) => { bridge.received.push({ data, sourceUrl }); },
          close: async () => { bridge.closeCalls++; await h.closeEffect?.(bridge); },
        };
        h.bridges.push(bridge); return bridge;
      } },
  };
  const out = {};
  new Function('exports', 'require', 'process', 'setTimeout', 'clearTimeout', screenSource)(out,
    name => { assert.ok(name in imports, `Unexpected screen import ${name}`); return imports[name]; },
    { env: { EXPO_PUBLIC_ONE_ACCESSIBILITY_ORIGIN: configuredOrigin } },
    (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; }, id => timers.delete(id));
  function nodes(node) {
    if (Array.isArray(node)) return node.flatMap(nodes);
    if (!node || typeof node !== 'object') return [];
    return [node, ...nodes(node.props?.children)];
  }
  function text(node) {
    if (Array.isArray(node)) return node.map(text).join('');
    if (typeof node === 'string') return node;
    return node && typeof node === 'object' ? text(node.props?.children) : '';
  }
  h.render = () => {
    cursor = 0; const tree = out.default(), all = nodes(tree);
    for (const view of all.filter(node => node.type === 'WebView')) {
      view.props.ref.current = { injectJavaScript: source => h.injections.push({ key: view.key, source }) };
    }
    for (const effect of effects.splice(0)) effect();
    return all;
  };
  h.view = () => h.render().find(node => node.type === 'WebView');
  h.button = label => {
    const found = h.render().find(node => node.type === 'Pressable' && text(node) === label);
    assert.ok(found, label); return found;
  };
  h.press = label => { const button = h.button(label); assert.ok(!button.props.disabled, label); button.props.onPress(); };
  h.message = () => h.render().filter(node => node.type === 'Text' && node.props.accessibilityLiveRegion === 'polite').map(text).join(' ');
  h.open = async () => { h.press('Ouvrir le parcours'); await flush(); return h.view(); };
  h.loaded = view => { view.props.onLoadStart(); view.props.onLoadEnd({ nativeEvent: { url } }); };
  h.background = () => { AppState.currentState = 'background'; for (const callback of appListeners) callback('background'); };
  h.foreground = () => { AppState.currentState = 'active'; for (const callback of appListeners) callback('active'); };
  h.unmount = () => {
    for (const slot of slots) if (slot?.cleanup) { const cleanup = slot.cleanup; slot.cleanup = undefined; cleanup(); }
    const cleanup = focusCleanup; focusCleanup = undefined; cleanup?.();
  };
  t.after(async () => { h.closeEffect = undefined; h.clearAuthorizationEffect = undefined; h.unmount(); await flush(); timers.clear(); });
  h.render(); return h;
}

test('the screen opens only after an explicit action and an exact configured origin', async t => {
  const missing = harness(t, { configuredOrigin: '' });
  assert.equal(missing.button('Ouvrir le parcours').props.disabled, true);
  assert.equal(missing.view(), undefined); assert.equal(missing.bridges.length, 0);
  const h = harness(t); await flush();
  assert.equal(h.view(), undefined); assert.equal(h.bridges.length, 0);
  const view = await h.open(); assert.ok(view); h.loaded(view);
  assert.equal(view.props.source.uri, url); assert.equal(h.bridges.length, 1);
  assert.equal(view.props.onShouldStartLoadWithRequest({ url: `${url}#read-text` }), true);
  for (const rejected of [`${origin}/account`, `${url}?next=private`, 'https://foreign.invalid/accessible-pour-moi']) {
    assert.equal(view.props.onShouldStartLoadWithRequest({ url: rejected }), false);
  }
  assert.equal(h.injections.length, 1); assert.equal(h.timers.size, 0);
});

test('an old WebView error, load or process callback cannot close a newer opening', async t => {
  for (const callback of ['onError', 'onLoadStart', 'onHttpError', 'onContentProcessDidTerminate', 'onRenderProcessGone']) {
    const h = harness(t), first = await h.open(); h.loaded(first);
    h.press('Arrêter et fermer'); await flush();
    const second = await h.open(); assert.ok(second);
    first.props[callback]({ nativeEvent: { url, statusCode: 503 } }); await flush();
    assert.equal(h.view()?.key, second.key, callback);
    // A stale load must not increment the new document's load counter either.
    h.loaded(second); await flush();
    assert.equal(h.view()?.key, second.key, callback);
    assert.match(h.message(), /Parcours ouvert/);
    assert.equal(h.bridges[1].closeCalls, 0); assert.equal(h.timers.size, 0);
  }
});

test('old messages, load completion and navigation callbacks cannot act on the replacement', async t => {
  const h = harness(t), first = await h.open(); h.loaded(first);
  h.press('Arrêter et fermer'); await flush();
  const second = await h.open(); h.loaded(second);
  const before = h.message(), injections = h.injections.length;
  first.props.onMessage({ nativeEvent: { data: 'old-document', url } });
  first.props.onLoadEnd({ nativeEvent: { url } }); first.props.onOpenWindow();
  assert.equal(first.props.onShouldStartLoadWithRequest({ url }), false);
  await flush();
  assert.deepEqual(h.bridges[1].received, []); assert.equal(h.injections.length, injections);
  assert.equal(h.message(), before);
  second.props.onMessage({ nativeEvent: { data: 'current-document', url } }); await flush();
  assert.deepEqual(h.bridges[1].received, [{ data: 'current-document', sourceUrl: url }]);
});

test('failed close stays pending, blocks replacement, and can be explicitly retried', async t => {
  const h = harness(t), first = await h.open(); h.loaded(first);
  h.closeEffect = async () => { throw new Error('Close not confirmed'); };
  h.press('Arrêter et fermer'); await flush();
  assert.equal(h.view(), undefined); assert.match(h.message(), /n’a pas été confirmé/);
  assert.equal(await h.open(), undefined); assert.equal(h.bridges.length, 1);
  h.closeEffect = undefined;
  h.press('Arrêter et fermer'); await flush();
  assert.match(h.message(), /Parcours et lien montre fermés/);
  const second = await h.open(); assert.ok(second);
  assert.equal(h.bridges.length, 2); assert.ok(h.bridges[0].closeCalls >= 3);
});

test('stop supersedes an opening waiting for a prior close without launching a late document', async t => {
  const h = harness(t), first = await h.open(); h.loaded(first);
  h.closeEffect = async () => { throw new Error('Close not confirmed'); };
  h.press('Arrêter et fermer'); await flush();
  const pending = deferred(); h.closeEffect = () => pending.promise;
  h.press('Ouvrir le parcours'); await flush();
  h.press('Arrêter et fermer'); await flush();
  pending.resolve(); await flush();
  assert.equal(h.view(), undefined); assert.equal(h.bridges.length, 1);
  assert.match(h.message(), /Parcours et lien montre fermés/);
  assert.equal(h.button('Ouvrir le parcours').props.disabled, false);
});

test('background and unmount close the session; returning to foreground never reopens it', async t => {
  const h = harness(t), view = await h.open(); h.loaded(view);
  h.background(); await flush();
  assert.equal(h.view(), undefined); assert.match(h.message(), /arrière-plan/);
  assert.ok(h.bridges[0].closeCalls > 0); assert.ok(h.authorizationClears > 0);
  h.foreground(); await flush(); assert.equal(h.view(), undefined); assert.equal(h.bridges.length, 1);
  await h.open(); h.unmount(); const updates = h.updates; await flush();
  assert.equal(h.updates, updates); assert.ok(h.bridges[1].closeCalls > 0);
  assert.equal(h.timers.size, 0);
});

test('written communication remains reachable without a configured ONE origin', async t => {
  const h = harness(t, { configuredOrigin: '' });
  h.press('Communiquer par écrit'); await flush();
  assert.deepEqual(h.replacements, ['/communication']);
  assert.equal(h.bridges.length, 0); assert.equal(h.view(), undefined);
  assert.ok(h.authorizationClears > 0);
});

test('written communication waits for closure and stays on the screen when closure fails', async t => {
  const h = harness(t); h.loaded(await h.open());
  h.closeEffect = async () => { throw new Error('Close not confirmed'); };
  h.press('Communiquer par écrit'); await flush();
  assert.deepEqual(h.replacements, []); assert.match(h.message(), /n’a pas été confirmé/);
  h.closeEffect = undefined;
  h.press('Communiquer par écrit'); await flush();
  assert.deepEqual(h.replacements, ['/communication']); assert.equal(h.view(), undefined);
});

test('a pending exit cannot navigate after the application backgrounds or the screen unmounts', async t => {
  for (const action of ['background', 'unmount']) {
    const h = harness(t); h.loaded(await h.open());
    const pending = deferred(); h.closeEffect = () => pending.promise;
    h.press('Communiquer par écrit'); await flush();
    h[action](); pending.resolve(); await flush();
    assert.deepEqual(h.replacements, [], action); assert.equal(h.backs, 0);
  }
});
