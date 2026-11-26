/** Mirrors the verifier's maximum read size; the native cores enforce it as well. */
export const MAX_DIGEST_BLOCK_BYTES = 256 * 1024;

export interface Sha256Digest {
  /** Consumes this view synchronously, without retaining its bytes. */
  update(bytes: Uint8Array): void;
  /** Returns 64 lowercase hexadecimal characters and closes the digest. */
  digestHex(): string;
  /** Closes the digest; safe to repeat before releasing the SharedObject. */
  destroy(): void;
  /** Expo SharedObject cleanup. Native methods cannot be called after release. */
  release(): void;
}

export interface PuramaLocalDigestNativeModule {
  Sha256Digest: new () => Sha256Digest;
}
