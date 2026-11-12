import { checkedAuthorization, isWatchIdentifier, serializeHandshake, serializeSend, type NativeWatchHost, type NativeWatchHandshakeRequest, type NativeWatchSendRequest, type WatchAuthorization, type WatchDevice, type WatchNativeStatus } from './contract';
export interface WatchNativeModule {
  discover(): Promise<WatchDevice[]>;
  authorize(input: string): Promise<void>;
  clearAuthorization(): Promise<void>;
  challenge(): string;
  monotonicTime(): number;
  open(request: string): Promise<string>;
  send(request: string, submittedAt: number): Promise<void>;
  cancel(requestId: string, deliveryId: string): Promise<void>;
  close(requestId: string): Promise<void>;
  addListener(event: 'onWatchMessage' | 'onWatchStatus', callback: (event: { message: string }) => void): { remove(): void };
}
/** Injectable only for software qualification. The production binding uses the
 * registered Expo module; it never substitutes a fake watch on unavailable platforms. */
export function createWatchNativeApi(native: WatchNativeModule | null) {
  const requireNative = () => { if (!native) throw new Error('native-unavailable'); return native; };
  return Object.freeze({
    discoverWatches: (): Promise<readonly WatchDevice[]> => requireNative().discover(),
    authorizeWatch: (input: WatchAuthorization): Promise<void> => requireNative().authorize(JSON.stringify(checkedAuthorization(input))),
    clearWatchAuthorization: (): Promise<void> => native?.clearAuthorization() ?? Promise.resolve(),
    createNativeWatchChallenge: (): string => {
      const value = requireNative().challenge();
      if (!isWatchIdentifier(value) || value.length > 64) throw new Error('challenge-unavailable');
      return value;
    },
    subscribeWatchStatus(callback: (status: WatchNativeStatus) => void): () => void {
      if (!native) { callback({ state: 'unavailable', reason: 'native-unavailable' }); return () => {}; }
      const sub = native.addListener('onWatchStatus', e => {
        if (typeof e.message !== 'string' || e.message.length > 4096) return;
        try { callback(JSON.parse(e.message) as WatchNativeStatus); } catch { /* No untrusted parsing exception enters native transport. */ }
      });
      return () => sub.remove();
    },
    createNativeWatchHost(): NativeWatchHost | undefined {
      if (!native) return;
      // Exact own fields are required by ONE's trustedHost validator.
      return Object.freeze({
        version: 1 as const,
        subscribe(callback: (input: unknown) => void) {
          const sub = native.addListener('onWatchMessage', e => {
            if (typeof e.message !== 'string' || e.message.length > 4096) return;
            try { callback(JSON.parse(e.message)); } catch { /* Invalid messages cannot become receipts. */ }
          });
          return () => sub.remove();
        },
        async handshake(request: Readonly<NativeWatchHandshakeRequest>, signal: AbortSignal) {
          const json = serializeHandshake(request);
          if (signal.aborted) throw new Error('closed');
          const cancel = () => { void native.close(request.requestId).catch(() => {}); };
          signal.addEventListener('abort', cancel, { once: true });
          try {
            const response = await native.open(json);
            if (signal.aborted) { cancel(); throw new Error('closed'); }
            if (typeof response !== 'string' || response.length > 4096) throw new Error('invalid-message');
            return JSON.parse(response);
          } finally { signal.removeEventListener('abort', cancel); }
        },
        async send(request: Readonly<NativeWatchSendRequest>, signal: AbortSignal) {
          if (signal.aborted) throw new Error('closed');
          const submittedAt = native.monotonicTime();
          if (!Number.isFinite(submittedAt) || submittedAt < 0 || submittedAt > Number.MAX_SAFE_INTEGER - 60_000) throw new Error('native-clock-unavailable');
          const input = serializeSend(request);
          if (signal.aborted) throw new Error('closed');
          const cancel = () => { signal.removeEventListener('abort', cancel); void native.cancel(input.requestId, input.deliveryId).catch(() => {}); };
          signal.addEventListener('abort', cancel, { once: true });
          try { await native.send(input.json, submittedAt); if (signal.aborted) throw new Error('closed'); }
          catch (e) { cancel(); throw e; }
          // Successful native enqueue does not detach the relay's cancellation.
          // ONE aborts the signal on completion/expiry/close, bounding this listener.
        },
        close: (requestId: string) => isWatchIdentifier(requestId) ? native.close(requestId) : Promise.reject(new TypeError('Invalid requestId')),
      });
    },
  });
}
