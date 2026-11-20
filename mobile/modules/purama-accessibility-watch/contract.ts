/** Wire-compatible with ONE src/lib/accessibility/watch-native-bridge.ts.
 * This is a native boundary, not a second relay coordinator or an event producer.
 * Arbitrary text, navigation instructions and simulated events are not inputs. */
export const WATCH_KINDS = ['doorbell', 'speech', 'siren', 'vehicle-sound', 'horn', 'knock', 'telephone-ring', 'vehicle', 'sensor-unavailable'] as const;
export type WatchKind = typeof WATCH_KINDS[number];
export type WatchPlatform = 'watchos' | 'wear-os';
export interface WatchDevice { readonly deviceId: string; readonly name: string; readonly platform: WatchPlatform }
export interface WatchAuthorization { readonly deviceId: string; readonly allowedKinds: readonly WatchKind[] }
export interface WatchNativeStatus {
  readonly state: 'idle' | 'discovering' | 'awaiting-watch' | 'connected' | 'disconnected' | 'revoked' | 'unavailable' | 'error';
  readonly requestId?: string;
  readonly deviceId?: string;
  readonly pairingCode?: string;
  readonly reason?: 'native-unavailable' | 'foreground-required' | 'no-device' | 'not-authorized' | 'watch-declined' | 'timeout' | 'link-lost' | 'invalid-message' | 'capacity' | 'closed' | 'native-error';
}
export interface WatchEvent {
  readonly version: 1; readonly eventId: string;
  readonly source: 'simulation' | 'microphone' | 'camera' | 'system'; readonly kind: WatchKind;
  readonly observedAt: number; readonly expiresAt: number; readonly assessment: 'provisional';
}
export interface WatchEnvelope {
  readonly version: 1; readonly type: 'one-awareness-delivery';
  readonly sessionId: string; readonly deviceId: string; readonly deliveryId: string;
  readonly event: WatchEvent; readonly remainingTtlMs: number;
}
export interface NativeWatchHandshakeRequest { readonly version: 1; readonly type: 'one-watch-handshake'; readonly requestId: string }
export interface NativeWatchSendRequest { readonly version: 1; readonly type: 'one-watch-send'; readonly requestId: string; readonly envelope: WatchEnvelope }
export interface NativeWatchHost {
  readonly version: 1;
  subscribe: (callback: (input: unknown) => void) => () => void;
  handshake: (request: Readonly<NativeWatchHandshakeRequest>, signal: AbortSignal) => unknown | Promise<unknown>;
  send: (request: Readonly<NativeWatchSendRequest>, signal: AbortSignal) => void | Promise<void>;
  close: (requestId: string) => void | Promise<void>;
}
export const isWatchIdentifier = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(x);
export function exactFields(x: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return;
    const p = Object.getPrototypeOf(x);
    if (p !== Object.prototype && p !== null) return;
    const own = Reflect.ownKeys(x);
    if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k))) return;
    const out: Record<string, unknown> = Object.create(null);
    for (const k of keys) { const d = Object.getOwnPropertyDescriptor(x, k); if (!d || !('value' in d)) return; out[k] = d.value; }
    return out;
  } catch { return; }
}
export function checkedAuthorization(input: unknown): WatchAuthorization {
  const p = exactFields(input, ['deviceId', 'allowedKinds']);
  if (!p || !isWatchIdentifier(p.deviceId) || !Array.isArray(p.allowedKinds) || !p.allowedKinds.length || p.allowedKinds.length > WATCH_KINDS.length) throw new TypeError('Invalid watch authorization');
  const kinds: WatchKind[] = [];
  for (let i = 0; i < p.allowedKinds.length; i++) {
    const d = Object.getOwnPropertyDescriptor(p.allowedKinds, String(i));
    if (!d || !('value' in d) || !WATCH_KINDS.includes(d.value) || kinds.includes(d.value)) throw new TypeError('Invalid allowed kinds');
    kinds.push(d.value);
  }
  return Object.freeze({ deviceId: p.deviceId, allowedKinds: Object.freeze(kinds) });
}
export function serializeHandshake(input: unknown): string {
  const p = exactFields(input, ['version', 'type', 'requestId']);
  if (!p || p.version !== 1 || p.type !== 'one-watch-handshake' || !isWatchIdentifier(p.requestId)) throw new TypeError('Invalid watch handshake');
  return JSON.stringify(p);
}
export function serializeSend(input: unknown): { json: string; requestId: string; deliveryId: string } {
  // Never serialize the caller's object or invoke its accessors.
  const r = exactFields(input, ['version', 'type', 'requestId', 'envelope']);
  const e = exactFields(r?.envelope, ['version', 'type', 'sessionId', 'deviceId', 'deliveryId', 'event', 'remainingTtlMs']);
  const v = exactFields(e?.event, ['version', 'eventId', 'source', 'kind', 'observedAt', 'expiresAt', 'assessment']);
  if (!r || r.version !== 1 || r.type !== 'one-watch-send' || !isWatchIdentifier(r.requestId)
    || !e || e.version !== 1 || e.type !== 'one-awareness-delivery' || ![e.sessionId, e.deviceId, e.deliveryId].every(isWatchIdentifier)
    || !Number.isSafeInteger(e.remainingTtlMs) || (e.remainingTtlMs as number) < 1 || (e.remainingTtlMs as number) > 60_000
    || !v || v.version !== 1 || !isWatchIdentifier(v.eventId) || v.assessment !== 'provisional'
    || !Number.isSafeInteger(v.observedAt) || !Number.isSafeInteger(v.expiresAt) || (v.observedAt as number) < 0
    || (v.expiresAt as number) > 8_640_000_000_000_000 - 60_000
    || (v.expiresAt as number) <= (v.observedAt as number) || (v.expiresAt as number) - (v.observedAt as number) > 60_000
    || !(v.source === 'microphone' && WATCH_KINDS.slice(0, 7).includes(v.kind as WatchKind)
      || v.source === 'camera' && v.kind === 'vehicle' || v.source === 'system' && v.kind === 'sensor-unavailable')) throw new TypeError('Invalid watch send');
  return { json: JSON.stringify({ ...r, envelope: { ...e, event: v } }), requestId: r.requestId, deliveryId: e.deliveryId as string };
}
