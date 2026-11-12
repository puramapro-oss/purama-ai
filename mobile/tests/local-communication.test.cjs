const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');
const React = require('react');
const Renderer = require('react-test-renderer');

global.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = React;
const project = path.resolve(__dirname, '..');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function environment({ configured = false, platform = 'ios', segments = ['communication'] } = {}) {
  const cache = new Map();
  const env = {
    segments, screen: null, fontError: null, fontsLoaded: true,
    factoryCalls: [], sessions: [], subscriptions: [], profileReads: [],
    networkCalls: [], persistentCalls: [], navigation: [], focus: [], keyboard: [],
    focusCleanups: new Set(), backListeners: new Set(), appStateListeners: new Set(), loaded: new Set(),
  };
  const unexpectedNetwork = (...args) => {
    env.networkCalls.push(args);
    throw new Error('This local route must not access a network');
  };
  const persistent = (...args) => {
    env.persistentCalls.push(args);
    throw new Error('This local route must not access persistent storage');
  };
  const client = {
    auth: {
      onAuthStateChange(callback) {
        const entry = { callback, unsubscribed: 0 };
        env.subscriptions.push(entry);
        return { data: { subscription: { unsubscribe() { entry.unsubscribed += 1; } } } };
      },
      getSession() {
        const pending = deferred();
        env.sessions.push(pending);
        return pending.promise;
      },
      signUp: unexpectedNetwork, signInWithPassword: unexpectedNetwork,
      signInWithOAuth: unexpectedNetwork, signOut: unexpectedNetwork,
      setSession: unexpectedNetwork, resetPasswordForEmail: unexpectedNetwork,
    },
    from(table) {
      assert.equal(this, client, 'the lazy facade must bind the real client');
      assert.equal(table, 'profiles', 'no unrelated account access is permitted');
      const pending = deferred();
      const read = { pending, userId: null };
      env.profileReads.push(read);
      return { select() { return this; }, eq(key, value) { assert.equal(key, 'id'); read.userId = value; return this; },
        single() { return pending.promise; } };
    },
  };
  env.client = client;

  const native = Object.fromEntries([
    'View', 'Text', 'TextInput', 'TouchableOpacity', 'ScrollView', 'KeyboardAvoidingView',
    'ActivityIndicator', 'FlatList', 'RefreshControl', 'Image', 'Pressable', 'Button', 'Switch',
  ].map(name => [name, name]));
  native.Platform = { OS: platform, select: options => options[platform] ?? options.default };
  native.StyleSheet = { create: styles => styles };
  native.Linking = { openURL: unexpectedNetwork };
  native.AppState = { currentState: 'active', addEventListener(name, callback) {
    assert.equal(name, 'change'); env.appStateListeners.add(callback);
    return { remove() { env.appStateListeners.delete(callback); } };
  } };
  native.Keyboard = { dismiss() { env.keyboard.push('dismiss'); } };
  native.AccessibilityInfo = { sendAccessibilityEvent(target, eventType) { env.focus.push({ target: target.testID, eventType }); } };
  if (platform === 'web') native.AccessibilityInfo = require('react-native-web/dist/cjs/exports/AccessibilityInfo');
  native.BackHandler = { addEventListener(name, callback) {
    assert.equal(name, 'hardwareBackPress'); env.backListeners.add(callback);
    return { remove() { env.backListeners.delete(callback); } };
  } };
  native.Alert = { alert() { throw new Error('Unexpected native alert'); } };
  native.Share = { share: unexpectedNetwork };
  function Stack() { return env.screen ? React.createElement(env.screen) : null; }
  Stack.Screen = () => null;
  function Tabs({ children }) { return React.createElement('Tabs', null, children); }
  Tabs.Screen = () => null;
  function useFocusEffect(callback) {
    React.useEffect(() => {
      const cleanup = callback();
      if (cleanup) env.focusCleanups.add(cleanup);
      return () => { env.focusCleanups.delete(cleanup); cleanup?.(); };
    }, [callback]);
  }
  const router = {
    push(href) { env.navigation.push(['push', href]); },
    replace(href) { env.navigation.push(['replace', href]); },
    back() { env.navigation.push(['back']); },
  };
  const modules = {
    react: React, 'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': native,
    'react-native-webview': { WebView: 'WebView' },
    'expo-modules-core': { requireOptionalNativeModule(name) {
      assert.equal(name, 'PuramaAccessibilityWatch');
      return null;
    } },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    'react-native-gesture-handler': { GestureHandlerRootView: 'GestureHandlerRootView' },
    'expo-router': { Stack, Tabs, router, useSegments: () => env.segments, useFocusEffect,
      useLocalSearchParams: () => ({}), Link: 'Link', Redirect: 'Redirect' },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    'expo-splash-screen': { preventAutoHideAsync: async () => {}, hideAsync: async () => {} },
    '@expo-google-fonts/syne': { useFonts: () => [env.fontsLoaded, env.fontError], Syne_400Regular: 1, Syne_700Bold: 2 },
    '@expo/vector-icons': { Ionicons: 'Ionicons' },
    'expo-secure-store': { getItemAsync: persistent, setItemAsync: persistent, deleteItemAsync: persistent },
    'react-native-url-polyfill/auto': {},
    'expo-web-browser': { openAuthSessionAsync: unexpectedNetwork },
    'expo-linking': { createURL: value => `purama://${value}` },
    'expo-haptics': { impactAsync: unexpectedNetwork, ImpactFeedbackStyle: { Light: 'light' } },
    'react-native-reanimated': { __esModule: true, default: { View: 'AnimatedView', Text: 'AnimatedText' },
      FadeInDown: {}, useSharedValue: value => ({ value }), useAnimatedStyle: callback => callback(),
      withSpring: value => value, withSequence: value => value },
    '@supabase/supabase-js': { createClient(...args) { env.factoryCalls.push(args); return client; } },
  };
  const environmentVariables = configured
    ? { EXPO_PUBLIC_SUPABASE_URL: 'https://example.invalid', EXPO_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-test-key' }
    : {};
  function load(relative) {
    let file = path.resolve(project, relative);
    if (file.endsWith('.css')) return {};
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index');
    if (!fs.existsSync(file)) file = ['.ts', '.tsx', '.js'].map(extension => file + extension).find(candidate => fs.existsSync(candidate));
    assert.ok(file, `Module not found: ${relative}`);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    env.loaded.add(path.relative(project, file));
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const localRequire = name => {
      if (Object.hasOwn(modules, name)) return modules[name];
      if (name.startsWith('@/')) return load(name.slice(2));
      if (name.startsWith('.')) return load(path.relative(project, path.resolve(path.dirname(file), name)));
      throw new Error(`Unreviewed external dependency: ${name}`);
    };
    vm.runInThisContext(`(function(require, module, exports, process, fetch, setTimeout) {\n${source}\n})`, { filename: file })(
      localRequire, module, module.exports, { env: environmentVariables }, unexpectedNetwork,
      () => { throw new Error('Local messages must not expire automatically'); },
    );
    return module.exports;
  }
  env.load = load;
  env.blur = () => { for (const cleanup of [...env.focusCleanups]) cleanup(); };
  env.hardwareBack = () => [...env.backListeners].reverse().some(listener => listener());
  env.nodeMock = element => ({ testID: element.props.testID, type: element.type,
    focus() { env.focus.push({ target: element.props.testID,
      eventType: element.type === 'TextInput' ? 'input-focus' : 'dom-focus' }); } });
  return env;
}

async function mount(env, Component, props = {}) {
  let renderer;
  await act(async () => { renderer = Renderer.create(React.createElement(Component, props), { createNodeMock: env.nodeMock }); });
  return renderer;
}
async function unmount(renderer) { await act(async () => renderer.unmount()); }
function control(renderer, id) {
  return renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)[0];
}
async function press(renderer, id) {
  const node = control(renderer, id);
  assert.ok(node, `Missing control: ${id}`);
  assert.notEqual(node.props.disabled, true, `Disabled control: ${id}`);
  await act(async () => { node.props.onPress(); });
}
async function type(renderer, text) {
  await act(async () => control(renderer, 'communication-input').props.onChangeText(text));
}
const session = id => ({ user: { id }, access_token: 'synthetic', refresh_token: 'synthetic', expires_in: 3600, token_type: 'bearer' });

test('only exact public route segments keep account initialization inactive', () => {
  const { isLocalCommunicationRoute, boundCommunicationText, COMMUNICATION_TEXT_LIMIT } = environment().load('lib/local-communication.ts');
  for (const segments of [[], ['index'], ['communication'], ['accessible-one'], ['accessibility-watch']]) {
    assert.equal(isLocalCommunicationRoute(segments), true);
  }
  for (const segments of [['(tabs)'], ['(tabs)', 'index'], ['(auth)', 'login'], ['account'], ['auth', 'callback'],
    ['communication', 'index'], ['communication-extra'], ['agent', '[slug]'],
    ['accessible-one', 'index'], ['accessibility-watch', 'index'], ['accessible-one-extra'], ['accessibility-watch-extra'],
    ['(auth)', 'accessible-one'], ['(tabs)', 'accessibility-watch'], ['Accessible-one']]) {
    assert.equal(isLocalCommunicationRoute(segments), false);
  }
  assert.equal(boundCommunicationText('Bonjour\nمرحبا 👋'), 'Bonjour\nمرحبا 👋');
  assert.equal(boundCommunicationText('x'.repeat(COMMUNICATION_TEXT_LIMIT - 1) + '👋').length, COMMUNICATION_TEXT_LIMIT - 1);
});

test('lazy client caches one instance, preserves method receiver and stable methods', () => {
  const { createLazyClient } = environment().load('lib/lazy-client.ts');
  let calls = 0;
  class Client { constructor() { this.auth = {}; } from(value) { assert.equal(this, real); return value; } }
  const real = new Client();
  const client = createLazyClient(() => { calls += 1; return real; });
  assert.equal(calls, 0);
  assert.equal(client.auth, real.auth);
  const from = client.from;
  assert.equal(from, client.from);
  assert.equal(from('profiles'), 'profiles');
  assert.ok(client instanceof Client);
  assert.equal(calls, 1);
  let attempts = 0;
  const retry = createLazyClient(() => { if (++attempts === 1) throw new Error('first failure'); return real; });
  assert.throws(() => retry.auth, /first failure/);
  assert.equal(retry.auth, real.auth);
  assert.equal(attempts, 2);
});

test('missing account configuration is harmless until explicit first access; original options are preserved', () => {
  const offline = environment();
  const client = offline.load('lib/supabase.ts').supabase;
  assert.equal(offline.factoryCalls.length, 0);
  assert.throws(() => client.auth, /Configuration du compte indisponible/);
  assert.equal(offline.factoryCalls.length, 0);
  const configured = environment({ configured: true });
  const configuredClient = configured.load('lib/supabase.ts').supabase;
  assert.equal(configuredClient.auth, configured.client.auth);
  assert.equal(configuredClient.auth, configured.client.auth);
  assert.equal(configured.factoryCalls.length, 1);
  const [url, key, options] = configured.factoryCalls[0];
  assert.equal(url, 'https://example.invalid'); assert.equal(key, 'synthetic-test-key');
  assert.equal(options.auth.autoRefreshToken, true); assert.equal(options.auth.persistSession, true);
  assert.equal(options.auth.detectSessionInUrl, false); assert.equal(options.db.schema, 'purama_ai');
  assert.deepEqual(Object.keys(options.auth.storage), ['getItem', 'setItem', 'removeItem']);
  assert.equal(offline.persistentCalls.length + configured.persistentCalls.length, 0);
});

test('installed Expo Router sync discovery imports every route without account configuration or network', () => {
  const env = environment();
  function files(directory) { return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]); }
  const routes = files(path.join(project, 'app')).filter(file => /\.[jt]sx?$/.test(file));
  const map = new Map(routes.map(file => ['./' + path.relative(path.join(project, 'app'), file).replaceAll(path.sep, '/'), file]));
  const context = key => env.load(path.relative(project, map.get(key)));
  context.keys = () => [...map.keys()];
  const routerFile = require.resolve('expo-router/build/getRoutesCore.js');
  const routerRequire = createRequire(routerFile);
  const module = { exports: {} };
  vm.runInThisContext(`(function(require, module, exports, process) {\n${fs.readFileSync(routerFile, 'utf8')}\n})`, { filename: routerFile })(
    routerRequire, module, module.exports, { env: { NODE_ENV: 'development' } });
  const tree = module.exports.getRoutes(context, { platform: 'ios', importMode: 'sync', ignoreEntryPoints: true });
  assert.ok(tree.children.some(route => route.route === 'communication'));
  assert.ok(tree.children.some(route => route.route === 'accessible-one'));
  assert.ok(tree.children.some(route => route.route === 'accessibility-watch'));
  assert.ok(tree.children.some(route => route.route === 'account'));
  for (const file of routes) assert.ok(env.loaded.has(path.relative(project, file)), `Route was not imported: ${file}`);
  assert.equal(env.factoryCalls.length, 0); assert.equal(env.networkCalls.length, 0); assert.equal(env.persistentCalls.length, 0);
});

for (const platform of ['ios', 'android']) test(`${platform}: local entry/deep link mounts a passive stable account provider without configuration`, async () => {
  const env = environment({ platform });
  const Root = env.load('app/_layout.tsx').default;
  const { useAuth } = env.load('hooks/useAuth.tsx');
  const seen = [];
  let mounts = 0;
  env.screen = function Probe() {
    seen.push(useAuth());
    React.useEffect(() => { mounts += 1; }, []);
    return React.createElement('Probe');
  };
  const renderer = await mount(env, Root);
  assert.equal(seen.at(-1).user, null); assert.equal(seen.at(-1).loading, true);
  for (const segments of [[], ['index'], ['accessible-one'], ['accessibility-watch'], ['communication']]) {
    env.segments = segments;
    await act(async () => renderer.update(React.createElement(Root)));
    assert.equal(seen.at(-1).user, null);
    assert.equal(seen.at(-1).loading, true);
    assert.equal(seen.at(-1).initializationError, null);
  }
  assert.equal(mounts, 1);
  assert.equal(env.sessions.length, 0); assert.equal(env.subscriptions.length, 0);
  assert.equal(env.factoryCalls.length, 0); assert.equal(env.networkCalls.length, 0); assert.equal(env.persistentCalls.length, 0);
  await unmount(renderer);
});

for (const publicRoute of ['communication', 'accessible-one', 'accessibility-watch']) test(`account → ${publicRoute} → account hides stale identity, ignores late work and reuses one client`, async () => {
  const env = environment({ configured: true, segments: ['account'] });
  const Root = env.load('app/_layout.tsx').default;
  const { useAuth } = env.load('hooks/useAuth.tsx');
  let state;
  let mounts = 0;
  env.screen = function Probe() { state = useAuth(); React.useEffect(() => { mounts += 1; }, []); return null; };
  const renderer = await mount(env, Root);
  assert.equal(state.loading, true); assert.equal(state.user, null);
  await act(async () => env.sessions[0].resolve({ data: { session: session('first') }, error: null }));
  assert.equal(state.user.id, 'first'); assert.equal(state.loading, false);
  assert.equal(env.profileReads.length, 1);
  env.segments = [publicRoute];
  await act(async () => renderer.update(React.createElement(Root)));
  assert.equal(state.user, null); assert.equal(state.session, null); assert.equal(state.profile, null);
  assert.equal(state.loading, true, 'retained protected screens must not redirect while local mode is active');
  assert.equal(env.subscriptions[0].unsubscribed, 1);
  await act(async () => {
    env.subscriptions[0].callback('SIGNED_IN', session('late'));
    env.profileReads[0].pending.resolve({ data: { id: 'first', email: 'synthetic@example.invalid' }, error: null });
  });
  assert.equal(state.user, null); assert.equal(state.profile, null); assert.equal(env.profileReads.length, 1);
  env.segments = ['account'];
  await act(async () => renderer.update(React.createElement(Root)));
  assert.equal(state.user, null); assert.equal(state.loading, true);
  assert.equal(env.factoryCalls.length, 1); assert.equal(env.sessions.length, 2); assert.equal(mounts, 1);
  await act(async () => env.sessions[1].resolve({ data: { session: session('second') }, error: null }));
  assert.equal(state.user.id, 'second'); assert.equal(state.loading, false);
  await act(async () => env.subscriptions[0].callback('SIGNED_IN', session('old-callback')));
  assert.equal(state.user.id, 'second');
  await unmount(renderer);
});

test('a pending old startup session cannot win after public mode and a new account activation', async () => {
  const env = environment({ configured: true, segments: ['account'] });
  const Root = env.load('app/_layout.tsx').default;
  const { useAuth } = env.load('hooks/useAuth.tsx');
  let state;
  env.screen = function Probe() { state = useAuth(); return null; };
  const renderer = await mount(env, Root);
  env.segments = ['communication']; await act(async () => renderer.update(React.createElement(Root)));
  env.segments = ['account']; await act(async () => renderer.update(React.createElement(Root)));
  await act(async () => env.sessions[0].resolve({ data: { session: session('stale') }, error: null }));
  assert.equal(state.user, null); assert.equal(state.loading, true);
  await act(async () => env.sessions[1].resolve({ data: { session: null }, error: null }));
  assert.equal(state.user, null); assert.equal(state.loading, false); assert.equal(env.profileReads.length, 0);
  await unmount(renderer);
});

test('a protected tabs deep link still waits for account validation then redirects unauthenticated users', async () => {
  const env = environment({ configured: true, segments: ['(tabs)', 'index'] });
  const Root = env.load('app/_layout.tsx').default;
  env.screen = env.load('app/(tabs)/_layout.tsx').default;
  const renderer = await mount(env, Root);
  assert.equal(env.factoryCalls.length, 1);
  assert.equal(renderer.root.findAllByType('Redirect').length, 0);
  assert.equal(renderer.root.findAllByType('Tabs').length, 0);
  await act(async () => env.sessions[0].resolve({ data: { session: null }, error: null }));
  assert.equal(renderer.root.findByType('Redirect').props.href, '/(auth)/login');
  env.segments = ['communication']; await act(async () => renderer.update(React.createElement(Root)));
  assert.equal(renderer.root.findAllByType('Redirect').length, 0, 'an inactive retained tabs screen must not leave the local route');
  await unmount(renderer);
});

test('font loading failure does not permanently hide the installed local entry', async () => {
  const env = environment(); env.fontsLoaded = false; env.fontError = new Error('synthetic font failure');
  const renderer = await mount(env, env.load('app/_layout.tsx').default);
  assert.equal(renderer.root.findAllByType('GestureHandlerRootView').length, 1);
  assert.equal(env.factoryCalls.length, 0);
  await unmount(renderer);
});

test('account startup without configuration shows recovery and can return to local communication', async () => {
  const env = environment({ segments: ['account'] });
  const Root = env.load('app/_layout.tsx').default;
  env.screen = env.load('app/account.tsx').default;
  const renderer = await mount(env, Root);
  assert.ok(control(renderer, 'account-unavailable-communication'));
  assert.equal(renderer.root.findAllByType('Redirect').length, 0);
  assert.equal(env.factoryCalls.length, 0);
  await press(renderer, 'account-unavailable-communication');
  assert.deepEqual(env.navigation.at(-1), ['replace', '/communication']);
  env.segments = ['communication'];
  env.screen = env.load('app/communication.tsx').default;
  await act(async () => renderer.update(React.createElement(Root)));
  assert.ok(control(renderer, 'communication-input'));
  await type(renderer, 'Je peux communiquer hors connexion.');
  await press(renderer, 'communication-show');
  assert.equal(control(renderer, 'communication-message').props.children, 'Je peux communiquer hors connexion.');
  assert.equal(env.factoryCalls.length, 0); assert.equal(env.networkCalls.length, 0);
  await unmount(renderer);
});

for (const operation of ['onAuthStateChange', 'getSession']) test(`synchronous ${operation} failure is recoverable and does not expose a session`, async () => {
  const env = environment({ configured: true, segments: ['account'] });
  env.client.auth[operation] = () => { throw new Error('synthetic initialization failure'); };
  const Root = env.load('app/_layout.tsx').default;
  const { useAuth } = env.load('hooks/useAuth.tsx');
  const Login = env.load('app/(auth)/login.tsx').default;
  let state;
  env.screen = function Probe() { state = useAuth(); return React.createElement(Login); };
  const renderer = await mount(env, Root);
  assert.equal(state.user, null); assert.equal(state.session, null); assert.equal(state.profile, null);
  assert.equal(state.loading, false); assert.match(state.initializationError, /compte/);
  assert.ok(control(renderer, 'account-unavailable-communication'));
  assert.equal(control(renderer, 'login-submit'), undefined);
  env.segments = ['communication'];
  await act(async () => renderer.update(React.createElement(Root)));
  assert.equal(state.initializationError, null); assert.equal(state.loading, true);
  if (operation === 'getSession') assert.equal(env.subscriptions[0].unsubscribed, 1);
  await unmount(renderer);
});

test('StrictMode ignores its discarded activation and the default provider still activates the account', async () => {
  const env = environment({ configured: true });
  const { AuthProvider, useAuth } = env.load('hooks/useAuth.tsx');
  let state;
  function Probe() { state = useAuth(); return null; }
  const renderer = await mount(env, React.StrictMode, {
    children: React.createElement(AuthProvider, null, React.createElement(Probe)),
  });
  assert.equal(env.factoryCalls.length, 1); assert.equal(env.sessions.length, 2);
  assert.equal(env.subscriptions[0].unsubscribed, 1);
  await act(async () => env.sessions[0].resolve({ data: { session: session('discarded') }, error: null }));
  assert.equal(state.user, null); assert.equal(env.profileReads.length, 0);
  await act(async () => env.sessions[1].resolve({ data: { session: session('current') }, error: null }));
  assert.equal(state.user.id, 'current'); assert.equal(env.profileReads.length, 1);
  await unmount(renderer);
});

for (const platform of ['ios', 'android']) test(`${platform}: write, present, resize, cancel/confirm clear and restore native focus`, async () => {
  const env = environment({ platform });
  const renderer = await mount(env, env.load('app/communication.tsx').default);
  assert.equal(control(renderer, 'communication-show').props.disabled, true);
  assert.equal(control(renderer, 'communication-clear').props.disabled, true);
  assert.equal(env.focus.length, 0, 'no unsolicited keyboard or accessibility focus on opening');
  await type(renderer, '   ');
  assert.equal(control(renderer, 'communication-show').props.disabled, true);
  await type(renderer, 'Bonjour\nمرحبا 👋');
  assert.equal(env.focus.length, 0, 'typing must not announce the entire draft');
  await press(renderer, 'communication-show');
  assert.equal(control(renderer, 'communication-message').props.children, 'Bonjour\nمرحبا 👋');
  assert.deepEqual(env.focus.at(-1), { target: 'communication-message', eventType: 'focus' });
  assert.equal(control(renderer, 'communication-message').props.style.fontSize, 32);
  const focusCount = env.focus.length;
  await press(renderer, 'communication-size');
  assert.equal(control(renderer, 'communication-message').props.style.fontSize, 48);
  assert.equal(control(renderer, 'communication-size').props.accessibilityState.selected, true);
  assert.equal(env.focus.length, focusCount, 'changing text size must not move focus');
  await press(renderer, 'communication-clear');
  assert.ok(control(renderer, 'communication-clear-title'));
  assert.equal(control(renderer, 'communication-message'), undefined);
  await press(renderer, 'communication-keep');
  assert.equal(control(renderer, 'communication-message').props.children, 'Bonjour\nمرحبا 👋');
  assert.deepEqual(env.focus.at(-1), { target: 'communication-clear', eventType: 'focus' });
  await press(renderer, 'communication-edit');
  assert.equal(control(renderer, 'communication-input').props.value, 'Bonjour\nمرحبا 👋');
  assert.deepEqual(env.focus.at(-1), { target: 'communication-input', eventType: 'focus' });
  await press(renderer, 'communication-clear');
  await press(renderer, 'communication-confirm-clear');
  assert.equal(control(renderer, 'communication-input').props.value, '');
  assert.equal(control(renderer, 'communication-show').props.disabled, true);
  assert.deepEqual(env.focus.slice(-2), [
    { target: 'communication-input', eventType: 'input-focus' }, { target: 'communication-input', eventType: 'focus' },
  ]);
  for (const node of renderer.root.findAll(node => typeof node.type === 'string' && node.type === 'TouchableOpacity')) {
    assert.equal(node.props.accessibilityRole, 'button');
    assert.ok(node.props.style.minHeight >= 56);
  }
  assert.equal(env.factoryCalls.length, 0); assert.equal(env.networkCalls.length, 0); assert.equal(env.persistentCalls.length, 0);
  await unmount(renderer);
});

test('hardware back cancels clear/returns to editing; route blur erases even a retained screen', async () => {
  const env = environment({ platform: 'android' });
  const renderer = await mount(env, env.load('app/communication.tsx').default);
  await type(renderer, 'Texte temporaire'); await press(renderer, 'communication-show');
  await press(renderer, 'communication-clear');
  await act(async () => assert.equal(env.hardwareBack(), true));
  assert.equal(control(renderer, 'communication-message').props.children, 'Texte temporaire');
  await act(async () => assert.equal(env.hardwareBack(), true));
  assert.equal(control(renderer, 'communication-input').props.value, 'Texte temporaire');
  assert.equal(env.hardwareBack(), false);
  await act(async () => env.blur());
  assert.equal(control(renderer, 'communication-input').props.value, '');
  assert.equal(env.backListeners.size, 0);
  await unmount(renderer);
});

test('RN Web without sendAccessibilityEvent uses focusable DOM refs and retains the exact shown text', async () => {
  const actualAccessibilityInfo = require('react-native-web/dist/cjs/exports/AccessibilityInfo');
  assert.equal(actualAccessibilityInfo.sendAccessibilityEvent, undefined);
  const env = environment({ platform: 'web' });
  const renderer = await mount(env, env.load('app/communication.tsx').default);
  const exactText = '  Un message\navec des espaces.  ';
  await type(renderer, exactText); await press(renderer, 'communication-show');
  assert.equal(control(renderer, 'communication-message').props.children, exactText);
  assert.equal(control(renderer, 'communication-message').props.tabIndex, -1);
  assert.deepEqual(env.focus.at(-1), { target: 'communication-message', eventType: 'dom-focus' });
  await press(renderer, 'communication-edit');
  assert.deepEqual(env.focus.at(-1), { target: 'communication-input', eventType: 'input-focus' });
  await press(renderer, 'communication-clear');
  assert.equal(control(renderer, 'communication-clear-title').props.tabIndex, -1);
  assert.deepEqual(env.focus.at(-1), { target: 'communication-clear-title', eventType: 'dom-focus' });
  await press(renderer, 'communication-keep');
  assert.deepEqual(env.focus.at(-1), { target: 'communication-clear', eventType: 'dom-focus' });
  await press(renderer, 'communication-clear'); await press(renderer, 'communication-confirm-clear');
  assert.equal(control(renderer, 'communication-input').props.value, '');
  assert.deepEqual(env.focus.at(-1), { target: 'communication-input', eventType: 'input-focus' });
  assert.equal(env.networkCalls.length, 0); assert.equal(env.persistentCalls.length, 0);
  await unmount(renderer);
});

for (const platform of ['ios', 'android']) test(`${platform}: public menu reaches ONE and watch settings without an account or automatic opening`, async () => {
  const env = environment({ platform, segments: [] });
  const Root = env.load('app/_layout.tsx').default;
  const Entry = env.load('app/index.tsx').default;
  const { Button } = env.load('components/ui/Button.tsx');
  env.screen = Entry;
  const renderer = await mount(env, Root);
  assert.deepEqual(env.navigation, []); assert.equal(env.factoryCalls.length, 0);
  assert.deepEqual(renderer.root.findAllByType(Button).map(node => ({
    id: node.props.testID, title: node.props.title, variant: node.props.variant ?? 'primary',
  })), [
    { id: 'entry-communication', title: 'Communiquer par écrit', variant: 'primary' },
    { id: 'entry-accessible-one', title: 'Accessible pour moi', variant: 'secondary' },
    { id: 'entry-account', title: 'Ouvrir mon espace compte', variant: 'secondary' },
  ]);
  await press(renderer, 'entry-communication');
  assert.deepEqual(env.navigation.at(-1), ['push', '/communication']);
  await press(renderer, 'entry-accessible-one');
  assert.deepEqual(env.navigation.at(-1), ['push', '/accessible-one']);
  env.segments = ['accessible-one'];
  env.screen = env.load('app/accessible-one.tsx').default;
  await act(async () => renderer.update(React.createElement(Root)));
  assert.ok(renderer.root.findAllByType('Text').some(node => node.props.children === 'Accessible pour moi'));
  assert.equal(renderer.root.findAllByType('WebView').length, 0, 'opening the public route must not open ONE automatically');
  assert.equal(env.navigation.length, 2);
  const watchSettings = renderer.root.findAllByType('Pressable').find(node =>
    node.findAllByType('Text').some(text => text.props.children === 'Régler ma montre'));
  assert.ok(watchSettings, 'watch settings must be reachable even when ONE has no configured origin');
  await act(async () => watchSettings.props.onPress());
  assert.deepEqual(env.navigation.at(-1), ['push', '/accessibility-watch']);
  env.segments = ['accessibility-watch'];
  env.screen = env.load('app/accessibility-watch.tsx').default;
  await act(async () => renderer.update(React.createElement(Root)));
  assert.ok(renderer.root.findAllByType('Text').some(node => node.props.children === 'Connexion à ma montre'));
  assert.equal(renderer.root.findAllByType('Redirect').length, 0);
  assert.equal(env.navigation.length, 3);
  assert.equal(env.sessions.length, 0); assert.equal(env.subscriptions.length, 0);
  env.segments = [];
  env.screen = Entry;
  await act(async () => renderer.update(React.createElement(Root)));
  await press(renderer, 'entry-account');
  assert.deepEqual(env.navigation.at(-1), ['push', '/account']);
  assert.equal(env.factoryCalls.length, 0); assert.equal(env.networkCalls.length, 0); assert.equal(env.persistentCalls.length, 0);
  await unmount(renderer);
  assert.equal(env.appStateListeners.size, 0);
});
