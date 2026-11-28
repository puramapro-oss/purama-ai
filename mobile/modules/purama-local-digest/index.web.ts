import type { PuramaLocalDigestNativeModule } from './contract';

/** Web has no native digest module; the existing bounded JavaScript verifier remains available. */
export function getPuramaLocalDigestModule(): PuramaLocalDigestNativeModule | null {
  return null;
}

export { MAX_DIGEST_BLOCK_BYTES } from './contract';
export type { PuramaLocalDigestNativeModule, Sha256Digest } from './contract';
