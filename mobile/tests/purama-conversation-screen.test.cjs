// The production screen and Button render unchanged. usePuramaConversation is
// an explicit mocked boundary; its real account/storage lifecycle is tested elsewhere.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const Renderer = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = Renderer;
const project = path.resolve(__dirname, '..');

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function record(id = '11111111-1111-4111-8111-111111111111') {
  return { ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', resourceId: id, localVersion: 1,
    serverRevision: 0, tombstone: false, updatedAt: '2026-11-23T12:00:00.000Z', syncState: 'pending',
    payload: { title: 'Conversation de test', draft: 'Bonjour', messages: [
      { id: '33333333-3333-4333-8333-333333333333', role: 'user', content: 'Bonjour', state: 'complete', createdAt: '2026-11-23T12:00:00.000Z' },
      { id: '44444444-4444-4444-8444-444444444444', role: 'assistant', content: 'Bonjour, je suis PURAMA.', state: 'complete', createdAt: '2026-11-23T12:00:01.000Z' },
    ] } };
}

async function mount(t, overrides = {}) {
  const env = { calls: [], alerts: [], network: [], dispatched: [], route: [], prevent: null, imports: [] };
  const current = record();
  const action = name => (...args) => { env.calls.push([name, ...args]); return Promise.resolve(); };
  env.chat = {
    phase: 'ready', error: null, preparing: false, syncState: 'paused', syncMessage: null,
    account: { ownerId: current.ownerId, validUntil: Date.now() + 1000000, autoSync: false },
    pack: { status: 'ready', progress: 1, completedBytes: 639446688, totalBytes: 639446688 },
    view: { record: current, conversations: [{ resourceId: current.resourceId, title: current.payload.title,
      localVersion: current.localVersion, serverRevision: current.serverRevision, updatedAt: current.updatedAt,
      syncState: current.syncState }], hasMoreHistory: false, draft: 'Bonjour', dirty: false, busy: false,
      transitioning: false, liveText: '', error: null, contextTruncated: false },
    verifyAccount: action('verifyAccount'), preparePack: action('preparePack'), setAutoSync: action('setAutoSync'),
    retry: action('retry'), newConversation: action('newConversation'), select: action('select'),
    resolve: action('resolve'), remove: action('remove'), synchronize: action('synchronize'),
    save: action('save'), send: action('send'), stop: action('stop'), setDraft: action('setDraft'),
    prepareToLeave: action('prepareToLeave'), loadMoreHistory: action('loadMoreHistory'),
  };
  const patch = updates => {
    const { view, ...rest } = updates;
    Object.assign(env.chat, rest);
    if (view) env.chat.view = { ...env.chat.view, ...view };
  };
  patch(overrides);
  const noNetwork = (...args) => { env.network.push(args); throw new Error('Presentation must not initiate networking'); };
  function FlatList(props) {
    const children = props.data.length ? props.data.map((item, index) => React.createElement(React.Fragment,
      { key: props.keyExtractor(item, index) }, props.renderItem({ item, index }))) : props.ListEmptyComponent;
    return React.createElement('FlatList', { ...props, renderItem: undefined, ListEmptyComponent: undefined }, children);
  }
  const native = Object.fromEntries(['View', 'Text', 'TextInput', 'ScrollView', 'KeyboardAvoidingView',
    'TouchableOpacity', 'Switch', 'ActivityIndicator', 'Modal'].map(name => [name, name]));
  Object.assign(native, { FlatList, Platform: { OS: 'android' }, StyleSheet: { create: styles => styles },
    Alert: { alert(...args) { env.alerts.push(args); } }, Linking: { openURL: noNetwork } });
  const dependencies = {
    react: React, 'react/jsx-runtime': require('react/jsx-runtime'), 'react-native': native,
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    'expo-router': { router: { back: () => env.route.push(['back']), push: route => env.route.push(['push', route]) } },
    '@expo/vector-icons': { Ionicons: 'Ionicons' },
    '@react-navigation/native': { useNavigation: () => ({ dispatch: action => env.dispatched.push(action) }),
      usePreventRemove: (enabled, callback) => { env.prevent = { enabled, callback }; } },
    '@/hooks/usePuramaConversation': { usePuramaConversation: () => env.chat },
  };
  const cache = new Map();
  function load(relative) {
    let file = path.resolve(project, relative);
    if (!fs.existsSync(file)) file = ['.ts', '.tsx'].map(extension => file + extension).find(candidate => fs.existsSync(candidate));
    assert.ok(file, `Missing module ${relative}`);
    if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    } }).outputText;
    const localRequire = name => {
      env.imports.push(name);
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (name.startsWith('@/')) return load(name.slice(2));
      if (name.startsWith('.')) return load(path.relative(project, path.resolve(path.dirname(file), name)));
      throw new Error(`Unreviewed screen dependency: ${name}`);
    };
    vm.runInThisContext(`(function(require,module,exports,fetch){${source}\n})`, { filename: file })(localRequire, module, module.exports, noNetwork);
    return module.exports;
  }
  const Screen = load('app/agent/purama.tsx').default;
  await act(async () => { env.renderer = Renderer.create(React.createElement(Screen)); });
  t.after(async () => { await act(async () => env.renderer.unmount()); });
  env.update = async updates => { patch(updates); await act(async () => env.renderer.update(React.createElement(Screen))); };
  env.node = id => env.renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)[0];
  env.button = label => env.renderer.root.findAll(node => node.type === 'TouchableOpacity' && node.props.accessibilityLabel === label)[0];
  env.text = () => env.renderer.root.findAllByType('Text').map(node => node.children.filter(child => typeof child === 'string').join('')).join('\n');
  env.press = async node => {
    assert.ok(node, 'Expected a rendered native control'); assert.notEqual(node.props.disabled, true, 'Control must be enabled before a user can press it');
    await act(async () => node.props.onPress());
  };
  return env;
}

test('one PURAMA identity and actual Button controls render without a provider/model chooser or network activity', async t => {
  const env = await mount(t);
  assert.ok(env.text().includes('PURAMA')); assert.ok(env.text().includes('Votre assistant personnel'));
  const send = env.node('purama-send');
  assert.equal(send.type, 'TouchableOpacity'); assert.equal(send.props.accessibilityLabel, 'Envoyer');
  assert.equal(send.props.accessibilityState.disabled, false);
  assert.equal(env.renderer.root.findAll(node => /Picker|Select|Dropdown/.test(String(node.type))).length, 0);
  assert.deepEqual(env.network, []); assert.deepEqual(env.calls, []);
  await env.press(env.node('purama-details'));
  assert.ok(env.text().includes('Apache 2.0'), 'attribution text remains available');
  const buttons = env.renderer.root.findAllByType('TouchableOpacity').map(node => node.props.accessibilityLabel ?? '');
  assert.equal(buttons.some(label => /choisir.*(modèle|fournisseur)|Qwen|llama|GPT/i.test(label)), false);
  assert.deepEqual(env.network, []);
});

for (const [name, state, expected] of [
  ['dirty', { dirty: true }, 'Enregistrement de votre saisie'],
  ['generating', { busy: true }, 'réponse en cours de sauvegarde'],
  ['uncheckpointed output', { liveText: 'Texte encore non enregistré' }, 'reste à enregistrer'],
]) test(`save hint never asserts fully saved while ${name}`, async t => {
  const env = await mount(t, { view: state });
  const text = env.node('purama-save-status').props.children;
  assert.ok(text.includes(expected)); assert.notEqual(text, 'Enregistré sur cet appareil');
});

test('saved locally and synchronized are distinct presentation states', async t => {
  const env = await mount(t, { syncState: 'pending' });
  assert.equal(env.node('purama-save-status').props.children, 'Enregistré sur cet appareil');
  assert.ok(env.text().includes('En attente de synchronisation'));
  assert.equal(env.text().includes('Synchronisé avec votre compte'), false);
  await env.update({ syncState: 'synced' });
  assert.ok(env.text().includes('Synchronisé avec votre compte'));
  await env.update({ view: { record: null } });
  assert.equal(env.node('purama-save-status').props.children, 'Votre conversation sera enregistrée sur cet appareil');
});

test('preparation is explicit and send remains disabled until the verified pack is ready', async t => {
  const env = await mount(t, { pack: { status: 'absent', progress: 0 } });
  assert.equal(env.node('purama-send').props.disabled, true); assert.ok(env.node('purama-prepare'));
  assert.deepEqual(env.calls, []);
  await env.press(env.node('purama-prepare')); assert.deepEqual(env.calls, [['preparePack']]);
  await env.update({ preparing: true, pack: { status: 'verifying', progress: 0.37 } });
  assert.equal(env.node('purama-send').props.disabled, true); assert.equal(env.node('purama-prepare'), undefined);
  assert.ok(env.text().includes('37 %')); await env.press(env.button('Arrêter la préparation'));
  assert.deepEqual(env.calls.at(-1), ['stop']);
  await env.update({ preparing: false, pack: { status: 'ready', progress: 1 } });
  assert.equal(env.node('purama-prepare'), undefined); assert.equal(env.node('purama-send').props.disabled, false);
  await env.press(env.node('purama-send')); assert.deepEqual(env.calls.at(-1), ['send']);
});

for (const status of ['downloading', 'verifying', 'error']) test(`a ${status} pack never enables generation`, async t => {
  const env = await mount(t, { pack: { status, progress: 0.9, message: 'État de préparation' } });
  assert.equal(env.node('purama-send').props.disabled, true);
});

test('busy and transitioning states block editing, conversation changes and deletion', async t => {
  const env = await mount(t, { view: { busy: true } });
  assert.equal(env.node('purama-input').props.editable, false);
  assert.equal(env.node('purama-history').props.disabled, true); assert.equal(env.node('purama-new').props.disabled, true);
  assert.equal(env.node('purama-delete'), undefined); assert.equal(env.node('purama-send'), undefined);
  await env.press(env.node('purama-stop')); assert.deepEqual(env.calls, [['stop']]);
  await env.update({ view: { busy: false, transitioning: true } });
  assert.equal(env.node('purama-input').props.editable, false); assert.equal(env.node('purama-send').props.disabled, true);
  assert.equal(env.node('purama-history').props.disabled, true); assert.equal(env.node('purama-new').props.disabled, true);
  assert.equal(env.node('purama-delete'), undefined);
});

test('draft changes are forwarded exactly and blank drafts cannot be submitted', async t => {
  const env = await mount(t);
  const text = 'Ligne 1\nمرحبا 👋';
  await act(async () => env.node('purama-input').props.onChangeText(text));
  assert.deepEqual(env.calls, [['setDraft', text]]);
  await env.update({ view: { draft: ' \n ' } }); assert.equal(env.node('purama-send').props.disabled, true);
});

test('history uses summaries and explicitly loads older conversations without opening one or networking', async t => {
  const env = await mount(t, { view: { hasMoreHistory: true } });
  await env.press(env.node('purama-history'));
  assert.ok(env.text().includes('Conversation de test'));
  assert.equal(env.node('purama-input'), undefined);
  assert.deepEqual(env.calls, []);
  await env.press(env.node('purama-more-history'));
  assert.deepEqual(env.calls, [['loadMoreHistory']]);
  assert.deepEqual(env.network, []);
  const older = { resourceId: '55555555-5555-4555-8555-555555555555', title: 'Conversation ancienne',
    localVersion: 2, serverRevision: 1, updatedAt: '2026-10-01T12:00:00.000Z', syncState: 'synced' };
  await env.update({ view: { conversations: [...env.chat.view.conversations, older], hasMoreHistory: false } });
  assert.ok(env.text().includes('Conversation ancienne'));
  assert.equal(env.node('purama-more-history'), undefined);
  await env.press(env.node(`purama-conversation-${older.resourceId}`));
  assert.deepEqual(env.calls.at(-1), ['select', older.resourceId]);
  assert.ok(env.node('purama-input'));
});

test('a history transition blocks duplicate page loading and selecting a different conversation', async t => {
  const env = await mount(t, { view: { hasMoreHistory: true } });
  await env.press(env.node('purama-history'));
  await env.update({ view: { transitioning: true } });
  assert.equal(env.node('purama-more-history').props.disabled, true);
  assert.equal(env.node(`purama-conversation-${env.chat.view.record.resourceId}`).props.disabled, true);
  assert.deepEqual(env.calls, []);
});

test('an empty history has no phantom page action', async t => {
  const env = await mount(t, { view: { conversations: [], hasMoreHistory: false } });
  await env.press(env.node('purama-history'));
  assert.ok(env.text().includes('Vos conversations apparaîtront ici'));
  assert.equal(env.node('purama-more-history'), undefined);
  assert.deepEqual(env.calls, []);
});

test('conflict keeps the local version visible and defaults to explicit keep-both action', async t => {
  const conflicted = record(); conflicted.syncState = 'conflict';
  const env = await mount(t, { view: { record: conflicted }, syncState: 'conflict' });
  assert.ok(env.text().includes('Votre version locale est conservée'));
  assert.ok(env.text().includes('Bonjour, je suis PURAMA.'));
  assert.equal(env.node('purama-input').props.editable, false); assert.equal(env.node('purama-send').props.disabled, true);
  await env.press(env.node('purama-keep-both')); assert.deepEqual(env.calls, [['resolve', 'keep-both']]);
  assert.equal(env.alerts.length, 0);
});

test('accepting the account version requires its own confirmation and cancellation has no effect', async t => {
  const conflicted = record(); conflicted.syncState = 'conflict';
  const env = await mount(t, { view: { record: conflicted } });
  await env.press(env.node('purama-accept-remote'));
  assert.deepEqual(env.calls, []); assert.equal(env.alerts.length, 1);
  const [title, description, actions] = env.alerts[0];
  assert.ok(title.includes('version du compte')); assert.ok(description.includes('conserver les deux'));
  assert.equal(actions.find(action => action.text === 'Annuler').style, 'cancel');
  assert.equal(actions.find(action => action.text === 'Annuler').onPress, undefined);
  await act(async () => actions.find(action => action.text === 'Reprendre').onPress());
  assert.deepEqual(env.calls, [['resolve', 'remote']]);
});

test('tombstoned conflicts do not offer replacing a deleted local record through the remote button', async t => {
  const conflicted = record(); conflicted.syncState = 'conflict'; conflicted.tombstone = true;
  const env = await mount(t, { view: { record: conflicted } });
  assert.equal(env.node('purama-accept-remote').props.disabled, true);
});

test('deletion requires a destructive confirmation and describes deferred synchronization', async t => {
  const env = await mount(t); await env.press(env.node('purama-delete'));
  assert.deepEqual(env.calls, []);
  const [, explanation, actions] = env.alerts[0];
  assert.ok(explanation.includes('lorsque la synchronisation sera possible'));
  assert.equal(actions.find(action => action.text === 'Conserver').style, 'cancel');
  const remove = actions.find(action => action.text === 'Supprimer'); assert.equal(remove.style, 'destructive');
  await act(async () => remove.onPress()); assert.deepEqual(env.calls, [['remove']]);
});

test('navigation waits for prepareToLeave to resolve before dispatching the original action', async t => {
  const pending = deferred();
  const env = await mount(t, { view: { dirty: true }, prepareToLeave: () => { env.calls.push(['prepareToLeave']); return pending.promise; } });
  assert.equal(env.prevent.enabled, true); const action = { type: 'GO_BACK', key: 'original-action' };
  await act(async () => env.prevent.callback({ data: { action } }));
  assert.deepEqual(env.calls, [['prepareToLeave']]); assert.deepEqual(env.dispatched, []);
  await act(async () => pending.resolve()); assert.deepEqual(env.dispatched, [action]);
});

test('navigation stays on the conversation when prepareToLeave rejects', async t => {
  const pending = deferred();
  const env = await mount(t, { view: { liveText: 'Réponse non enregistrée' }, prepareToLeave: () => pending.promise });
  assert.equal(env.prevent.enabled, true);
  await act(async () => env.prevent.callback({ data: { action: { type: 'GO_BACK' } } }));
  await act(async () => pending.reject(new Error('synthetic disk failure')));
  assert.deepEqual(env.dispatched, []);
});

test('account preparation and login are explicit; a local message containing a URL stays inert text', async t => {
  const env = await mount(t, { phase: 'account' });
  assert.deepEqual(env.calls, []); assert.deepEqual(env.network, []);
  assert.equal(env.node('purama-input'), undefined);
  await env.press(env.node('purama-verify-account')); assert.deepEqual(env.calls, [['verifyAccount']]);
  await env.press(env.node('purama-login')); assert.deepEqual(env.route, [['push', '/account']]);
  const local = record(); local.payload.messages[1].content = 'Une adresse dans le texte : https://example.invalid';
  await env.update({ phase: 'ready', view: { record: local } });
  const text = env.renderer.root.findAllByType('Text').find(node => node.props.children === local.payload.messages[1].content);
  assert.ok(text); assert.equal(text.props.onPress, undefined); assert.equal(text.props.selectable, true);
  assert.deepEqual(env.network, []);
});

test('interrupted content, live pending text, and bounded inference history are labelled honestly', async t => {
  const local = record(); local.payload.messages[1] = { ...local.payload.messages[1], state: 'interrupted', content: 'Réponse partielle' };
  const env = await mount(t, { view: { record: local, contextTruncated: true } });
  assert.ok(env.text().includes('Réponse partielle')); assert.ok(env.text().includes('contenu partiel conservé'));
  assert.ok(env.text().includes('L’historique complet reste enregistré'));
  local.payload.messages[1] = { ...local.payload.messages[1], state: 'pending', content: '' };
  await env.update({ view: { record: local, busy: true, liveText: 'Réponse native en cours' } });
  assert.ok(env.text().includes('Réponse native en cours')); assert.ok(env.text().includes('Réponse en cours…'));
});

test('component licences open locally with complete texts and close without leaving the conversation', async t => {
  const env = await mount(t);
  assert.equal(env.node('purama-license-texts'), undefined);
  await env.press(env.node('purama-details'));
  await env.press(env.node('purama-licenses'));
  const notices = JSON.parse(fs.readFileSync(path.join(project, 'assets/iao-third-party-notices.json'), 'utf8'));
  const rendered = env.renderer.root.findAllByType('Text');
  for (const component of notices.components) {
    for (const notice of component.texts) {
      const text = rendered.find(node => node.props.children === notice.content);
      assert.ok(text, `Full notice missing for ${component.name}`);
      assert.equal(text.props.selectable, true); assert.equal(text.props.onPress, undefined);
    }
    for (const source of component.sources) {
      assert.ok(rendered.some(node => node.props.children === source && node.props.onPress === undefined));
    }
  }
  assert.deepEqual(env.calls, []); assert.deepEqual(env.network, []);
  await env.press(env.node('purama-licenses-close'));
  assert.equal(env.node('purama-license-texts'), undefined);
  await env.press(env.node('purama-licenses'));
  await act(async () => env.renderer.root.findByType('Modal').props.onRequestClose());
  assert.equal(env.node('purama-license-texts'), undefined); assert.deepEqual(env.route, []);
});

test('bundled notices retain installed copyright texts and the exact publisher licence for the verified model', () => {
  const { createHash } = require('node:crypto');
  const notices = JSON.parse(fs.readFileSync(path.join(project, 'assets/iao-third-party-notices.json'), 'utf8'));
  for (const [name, relative] of [['llama.rn', 'llama.rn/LICENSE'], ['llama.cpp / ggml', 'llama.rn/cpp/LICENSE'], ['@noble/hashes', '@noble/hashes/LICENSE']]) {
    const source = fs.readFileSync(path.join(project, 'node_modules', relative), 'utf8');
    assert.ok(notices.components.find(component => component.name === name).texts.some(notice => notice.content === source));
  }
  const qwen = notices.components.find(component => component.name === 'Qwen3-0.6B GGUF').texts.find(notice => notice.title === 'Licence complète fournie par Qwen').content;
  assert.equal(createHash('sha256').update(qwen, 'utf8').digest('hex'), '5de36594c10839788a8c589443a8ef9d8b8d17c65a1b5807206ae037fc36c6bd');
  assert.ok(notices.components.find(component => component.name === 'SQLCipher').texts.some(notice => notice.content.includes('Copyright (c) 2008-2024, ZETETIC LLC')));
});
