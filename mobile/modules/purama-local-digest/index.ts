// Keep a public runtime value so tree shaking cannot discard Expo's initialization.
import { SharedObject } from 'expo-modules-core';
import type { PuramaLocalDigestNativeModule } from './contract';

/** Lookup is deferred until the existing pack verifier asks for a digest. */
export function getPuramaLocalDigestModule(): PuramaLocalDigestNativeModule | null {
  if (typeof SharedObject !== 'function') {
    throw new Error('Expo SharedObject runtime is unavailable');
  }
  const registry = globalThis.expo?.modules;
  if (registry === null || typeof registry !== 'object') {
    throw new Error('Expo native module registry is unavailable');
  }
  // requireOptionalNativeModule catches lookup failures and returns null in SDK 54.
  // Reading the public JSI registry directly preserves failures as failures.
  const native: unknown = registry.PuramaLocalDigest;
  if (native === null || native === undefined) return null;
  if ((typeof native !== 'object' && typeof native !== 'function') ||
      typeof (native as PuramaLocalDigestNativeModule).Sha256Digest !== 'function') {
    throw new Error('PuramaLocalDigest has no SHA-256 constructor');
  }
  return native as PuramaLocalDigestNativeModule;
}

export { MAX_DIGEST_BLOCK_BYTES } from './contract';
export type { PuramaLocalDigestNativeModule, Sha256Digest } from './contract';
