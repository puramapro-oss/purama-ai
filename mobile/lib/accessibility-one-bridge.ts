import type { NativeWatchHost } from '../modules/purama-accessibility-watch';

const ROUTE = '/accessible-pour-moi';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const CHANNEL = 'purama-one-watch-v1';
const MAX_CALLS = 128;

/** A build-time origin, never a URL supplied by a deep link or web message. */
export function parseOneOrigin(value: string | undefined): string | null {
  if (!value || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

export function isOneAccessibilityUrl(value: string, origin: string): boolean {
  try {
    const url = new URL(value);
    return parseOneOrigin(origin) === origin && url.origin === origin
      && !url.username && !url.password && url.pathname === ROUTE && !url.search;
  } catch { return false; }
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

/**
 * One document / one cryptographic token. All native operations are scoped to
 * the attempt that requested them. The screen destroys this channel on every
 * full navigation, background transition or close; anchors remain in-page.
 * A fulfilled native send is only a transport result, never a watch receipt.
 */
export function createOneWebBridge(host: NativeWatchHost, options: {
  origin: string;
  token: string;
  inject: (source: string) => void;
  onError: (message: string) => void;
  monotonicNow?: () => number;
}) {
  if (parseOneOrigin(options.origin) !== options.origin || !ID.test(options.token)) throw new Error('Invalid native web bridge configuration');
  type Call = { controller: AbortController; requestId: string; timer?: ReturnType<typeof setTimeout>;
    freshness?: { startedAt: number; resolve: (fresh: { deadline: number; checkedAt: number }) => void; reject: (error: Error) => void } };
  const calls = new Map<number, Call>();
  const attempts = new Set<string>();
  let activeAttempt: string | null = null;
  let disposed = false;
  let failedClose = false;
  let subscriptionClosed = false;
  let closing: Promise<void> | undefined;
  let serial = 0;
  const monotonicNow = options.monotonicNow ?? (() => globalThis.performance?.now() ?? NaN);

  function reply(payload: Record<string, unknown>) {
    if (disposed) return;
    const data = JSON.stringify({ channel: CHANNEL, token: options.token, ...payload });
    // Data is JSON encoded, never concatenated as executable fields or HTML.
    options.inject(`window.__PURAMA_ONE_WATCH_REPLY__?.(${data});true;`);
  }
  function forget(id: number, abort: boolean) {
    const call = calls.get(id);
    if (!call) return;
    calls.delete(id);
    if (call.timer) clearTimeout(call.timer);
    call.freshness?.reject(new Error('Native delivery cancelled'));
    call.freshness = undefined;
    if (abort) call.controller.abort();
  }
  function abortAttempt(requestId: string) {
    for (const [id, call] of calls) if (call.requestId === requestId) forget(id, true);
    if (activeAttempt === requestId) activeAttempt = null;
  }
  async function closeAttempt(requestId: string) {
    abortAttempt(requestId);
    if (!attempts.has(requestId)) return;
    try {
      await host.close(requestId);
      attempts.delete(requestId);
      if (!attempts.size) failedClose = false;
    } catch {
      failedClose = true;
      options.onError('La fermeture du lien montre n’a pas été confirmée. Réessayez l’arrêt.');
      throw new Error('Native watch close unconfirmed');
    }
  }
  const unsubscribe = host.subscribe(input => {
    if (disposed || !input || typeof input !== 'object') return;
    const message = input as Record<string, unknown>;
    if (message.requestId !== activeAttempt || !attempts.has(String(message.requestId))) return;
    // The existing ONE protocol validates every received field and receipt.
    reply({ type: 'event', value: input });
    if (message.type === 'one-watch-disconnected' || message.type === 'one-watch-revoked') {
      abortAttempt(String(message.requestId));
    }
  });

  async function receive(raw: string, sourceUrl: string): Promise<void> {
    if (disposed || !isOneAccessibilityUrl(sourceUrl, options.origin) || raw.length > 16_384) return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!exact(parsed, ['channel', 'token', 'id', 'method', 'value']) || parsed.channel !== CHANNEL
        || parsed.token !== options.token || !Number.isSafeInteger(parsed.id) || (parsed.id as number) < 1) return;
      message = parsed;
    } catch { return; }
    const id = message.id as number;
    if (message.method === 'cancel') {
      if (Number.isSafeInteger(message.value)) forget(message.value as number, true);
      return;
    }
    if (id <= serial || calls.has(id)) return;
    serial = id;
    if (message.method === 'resolved-delivery') {
      if (!exact(message.value, ['id', 'remainingTtlMs'])) return;
      const value = message.value;
      const call = Number.isSafeInteger(value.id) ? calls.get(value.id as number) : undefined;
      const freshness = call?.freshness;
      if (!call || !freshness) return;
      call.freshness = undefined;
      let at = NaN;
      try { at = monotonicNow(); } catch { /* Rejected below. */ }
      const budget = typeof value.remainingTtlMs === 'number'
        ? Math.floor(value.remainingTtlMs - (at - freshness.startedAt)) : NaN;
      if (!Number.isFinite(at) || at < freshness.startedAt || !Number.isSafeInteger(value.remainingTtlMs)
        || (value.remainingTtlMs as number) < 1 || (value.remainingTtlMs as number) > 60_000 || budget < 1) {
        freshness.reject(new Error('Native delivery expired'));
      } else freshness.resolve({ deadline: at + budget, checkedAt: at });
      return;
    }
    if (message.method === 'close') {
      if (typeof message.value !== 'string' || !ID.test(message.value)) return;
      try { await closeAttempt(message.value); reply({ type: 'result', id, ok: true }); }
      catch { reply({ type: 'result', id, ok: false, error: 'close-unconfirmed' }); }
      return;
    }
    const value = message.value;
    if ((message.method !== 'handshake' && message.method !== 'send') || !value || typeof value !== 'object') return;
    const request = value as Record<string, unknown>;
    const requestId = request.requestId;
    const handshake = message.method === 'handshake';
    if (!exact(request, handshake ? ['version', 'type', 'requestId'] : ['version', 'type', 'requestId', 'envelope'])
      || request.version !== 1 || request.type !== (handshake ? 'one-watch-handshake' : 'one-watch-send')
      || typeof requestId !== 'string' || !ID.test(requestId)) return;
    if (failedClose || calls.size >= MAX_CALLS || (handshake ? attempts.size !== 0 : activeAttempt !== requestId)) {
      reply({ type: 'result', id, ok: false, error: 'native-channel-unavailable' }); return;
    }
    let budget = 60_000;
    if (!handshake) {
      const envelope = request.envelope as Record<string, unknown> | undefined;
      if (!envelope || !Number.isSafeInteger(envelope.remainingTtlMs) || (envelope.remainingTtlMs as number) < 1
        || (envelope.remainingTtlMs as number) > 60_000) {
        reply({ type: 'result', id, ok: false, error: 'invalid-delivery' }); return;
      }
      budget = envelope.remainingTtlMs as number;
    }
    const call: Call = { controller: new AbortController(), requestId };
    calls.set(id, call);
    if (handshake) { attempts.add(requestId); activeAttempt = requestId; }
    call.timer = setTimeout(() => {
      forget(id, true);
      reply({ type: 'result', id, ok: false, error: 'native-timeout' });
      if (handshake) void closeAttempt(requestId).catch(() => {});
    }, budget);
    try {
      let nativeRequest = request;
      if (!handshake) {
        const startedAt = monotonicNow();
        if (!Number.isFinite(startedAt)) throw new Error('Native clock unavailable');
        // Independent clocks need no synchronization: the document reduces its
        // own original budget, then we subtract our entire request/reply trip.
        const fresh = await new Promise<{ deadline: number; checkedAt: number }>((resolve, reject) => {
          call.freshness = { startedAt, resolve, reject };
          reply({ type: 'resolve-delivery', id });
        });
        if (disposed || call.controller.signal.aborted || calls.get(id) !== call) return;
        const dispatchAt = monotonicNow();
        if (!Number.isFinite(dispatchAt) || dispatchAt < fresh.checkedAt) throw new Error('Native clock fault');
        budget = Math.min(budget, Math.floor(fresh.deadline - dispatchAt));
        if (budget < 1) throw new Error('Native delivery expired');
        nativeRequest = { ...request, envelope: { ...(request.envelope as Record<string, unknown>), remainingTtlMs: budget } };
        if (call.timer) clearTimeout(call.timer);
        call.timer = setTimeout(() => forget(id, true), budget);
      }
      const result = handshake
        ? await host.handshake(request as Parameters<NativeWatchHost['handshake']>[0], call.controller.signal)
        : await host.send(nativeRequest as Parameters<NativeWatchHost['send']>[0], call.controller.signal);
      if (disposed || call.controller.signal.aborted || calls.get(id) !== call) return;
      if (handshake && call.timer) { clearTimeout(call.timer); call.timer = undefined; }
      // Keep successful calls cancellable for the connection / delivery lifetime.
      reply({ type: 'result', id, ok: true, ...(handshake ? { value: result } : {}) });
    } catch {
      forget(id, true);
      reply({ type: 'result', id, ok: false, error: 'native-operation-failed' });
      if (handshake) void closeAttempt(requestId).catch(() => {});
    }
  }

  function close(): Promise<void> {
    if (closing) return closing;
    disposed = true;
    const pending = Promise.resolve().then(async () => {
      if (!subscriptionClosed) {
        try { unsubscribe(); subscriptionClosed = true; }
        catch { options.onError('La fermeture de l’écoute montre doit être vérifiée.'); }
      }
      for (const id of calls.keys()) forget(id, true);
      activeAttempt = null;
      const outcomes = await Promise.allSettled([...attempts].map(closeAttempt));
      if (!subscriptionClosed || outcomes.some(result => result.status === 'rejected')) throw new Error('Native watch close unconfirmed');
    });
    closing = pending;
    const settled = () => { if (closing === pending) closing = undefined; };
    void pending.then(settled, settled);
    return pending;
  }
  return Object.freeze({ receive, close });
}

/** Injected only in the validated top-level ONE page after it has loaded. */
export function buildOneNativeHostScript(origin: string, token: string): string {
  if (parseOneOrigin(origin) !== origin || !ID.test(token)) throw new Error('Invalid native web bridge configuration');
  const config = JSON.stringify({ origin, token, channel: CHANNEL });
  return `(function(config) {
    if (window.top !== window || location.origin !== config.origin || location.pathname !== '/accessible-pour-moi' || location.search) return;
    if (!window.ReactNativeWebView || Object.prototype.hasOwnProperty.call(window, '__PURAMA_ONE_WATCH_HOST__')) return;
    const pending = new Map(), listeners = new Set();
    let serial = 0, closed = false;
    function post(method, value) {
      const id = ++serial;
      window.ReactNativeWebView.postMessage(JSON.stringify({channel:config.channel,token:config.token,id,method,value}));
      return id;
    }
    function release(id, abort) {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id); clearTimeout(entry.timer);
      entry.signal?.removeEventListener('abort', entry.cancel);
      if (abort) { post('cancel', id); entry.reject(new Error('Native operation cancelled')); }
    }
    function rpc(method, value, signal) {
      if (closed || signal?.aborted || pending.size >= 128) return Promise.reject(new Error('Native channel unavailable'));
      return new Promise((resolve, reject) => {
        const id = ++serial;
        const at = performance.now();
        if (!Number.isFinite(at)) { reject(new Error('Document clock unavailable')); return; }
        const entry = {resolve,reject,signal,method,startedAt:at,budget:method==='send'?value.envelope.remainingTtlMs:60000,requestId:typeof value==='string'?value:value.requestId,timer:null,cancel:null};
        entry.cancel = () => release(id, true);
        pending.set(id, entry);
        signal?.addEventListener('abort', entry.cancel, {once:true});
        const budget = method === 'send' ? value.envelope.remainingTtlMs : 60000;
        entry.timer = setTimeout(() => release(id, true), budget);
        if (signal?.aborted) { release(id,true); return; }
        try { window.ReactNativeWebView.postMessage(JSON.stringify({channel:config.channel,token:config.token,id,method,value})); }
        catch (error) { release(id,false); reject(error); }
      });
    }
    Object.defineProperty(window, '__PURAMA_ONE_WATCH_REPLY__', {configurable:false,writable:false,value:function(message) {
      if (closed || !message || message.channel !== config.channel || message.token !== config.token) return;
      if (message.type === 'resolve-delivery') {
        const entry = pending.get(message.id);
        const at = performance.now();
        const remaining = entry && entry.method === 'send' && !entry.signal?.aborted && Number.isFinite(at) && at >= entry.startedAt
          ? Math.max(0, Math.floor(entry.budget - (at - entry.startedAt))) : 0;
        post('resolved-delivery', {id:message.id,remainingTtlMs:remaining});
        return;
      }
      if (message.type === 'event') {
        for (const listener of [...listeners]) { try { listener(message.value); } catch {} }
        return;
      }
      if (message.type !== 'result') return;
      const entry = pending.get(message.id);
      if (!entry) return;
      if (!message.ok) { release(message.id,false); entry.reject(new Error(message.error || 'Native operation failed')); return; }
      // An accepted transport stays cancellable. Closing / TTL frees the entry.
      if (entry.method === 'handshake') clearTimeout(entry.timer);
      entry.resolve(message.value);
    }});
    const facade = Object.freeze({version:1,
      subscribe(callback) { if (closed) throw new Error('Native channel closed'); listeners.add(callback); return () => listeners.delete(callback); },
      handshake(request, signal) { return rpc('handshake',request,signal); },
      send(request, signal) { return rpc('send',request,signal); },
      close(requestId) {
        for (const [id,entry] of pending) if (entry.requestId === requestId) release(id,true);
        return rpc('close',requestId).finally(() => { for (const [id,entry] of pending) if (entry.requestId === requestId) release(id,false); });
      }
    });
    Object.defineProperty(window, '__PURAMA_ONE_WATCH_HOST__', {configurable:false,writable:false,value:facade});
    window.addEventListener('pagehide', () => {
      for (const id of [...pending.keys()]) release(id,true);
      closed = true; listeners.clear();
    }, {once:true});
    window.dispatchEvent(new Event('purama-one-watch-host-ready'));
  })(${config});true;`;
}
