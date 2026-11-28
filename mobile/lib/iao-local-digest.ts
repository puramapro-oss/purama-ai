import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { MAX_DIGEST_BLOCK_BYTES } from "../modules/purama-local-digest/contract";

/** A file verifier owns one bounded, incremental digest and always destroys it. */
export interface IaoLocalDigest {
  readonly implementation: "native-sha256" | "noble-sha256";
  update(bytes: Uint8Array): void;
  digestHex(): string;
  destroy(): void;
}

function assertBlock(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_DIGEST_BLOCK_BYTES) {
    throw new RangeError("SHA-256 requires a Uint8Array of at most 256 KiB.");
  }
}

/** No native lookup at import or controller construction, and no file access. */
export async function createIaoLocalDigest(): Promise<IaoLocalDigest> {
  const { getPuramaLocalDigestModule } = await import("../modules/purama-local-digest/index");
  const module = getPuramaLocalDigestModule();
  if (module === null) {
    // Compatibility for binaries built before this local Expo module existed.
    // Once a native module is present, its errors must fail closed, not switch
    // implementations part-way through a file or silently hide a broken build.
    const digest = sha256.create();
    return {
      implementation: "noble-sha256",
      update(bytes) { assertBlock(bytes); digest.update(bytes); },
      digestHex: () => bytesToHex(digest.digest()),
      destroy: () => digest.destroy(),
    };
  }
  const digest = new module.Sha256Digest();
  let released = false;
  return {
    implementation: "native-sha256",
    update(bytes) { assertBlock(bytes); digest.update(bytes); },
    digestHex: () => digest.digestHex(),
    destroy() {
      if (released) return;
      released = true;
      let failed = false;
      let failure: unknown;
      try { digest.destroy(); }
      catch (error) { failed = true; failure = error; }
      try { digest.release(); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
      if (failed) throw failure;
    },
  };
}
