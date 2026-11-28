/**
 * Qualification fixtures only. This module opens no model, memory store, account,
 * or network transport. Native and file imports require the exact build flag.
 */
import contract from "./iao-digest-qualification-contract.json";
import type { Sha256Digest } from "../modules/purama-local-digest/contract";
import type { IaoLocalDigest } from "./iao-local-digest";

export type IaoDigestQualificationReceipt = Readonly<{
  schema: 1;
  status: "PASS" | "FAIL";
  runId: string;
  commit: string;
  platform: "ios" | "android" | "web" | "unknown";
  engine: "hermes" | "unknown";
  bundleSource: "embedded" | "unknown";
  backend: "native-sha256" | "unknown";
  checks: Readonly<Record<string, boolean>>;
  elapsedMs: number;
  completedAt: string;
  errorCode: string | null;
}>;

const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const BLOCK_A = "dd3dde87623d9a6b354c68c943d189c89c63652d945e7bbdf0986cae91a49521";
const MILLION_A = "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0";
const MAX_BLOCK_BYTES = 262_144;
let running: Promise<IaoDigestQualificationReceipt> | undefined;

class DigestQualificationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "DigestQualificationError"; }
}

function requireCheck(condition: unknown, code: string): asserts condition {
  if (!condition) throw new DigestQualificationError(code);
}

function rejected(action: () => unknown, code: string): void {
  let refused = false;
  try { action(); } catch { refused = true; }
  requireCheck(refused, code);
}

export function runIaoDigestQualification(onStatus?: (status: string) => void): Promise<IaoDigestQualificationReceipt> {
  // These literal property accesses are deliberately inlinable by Expo.
  const enabled = process.env.EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION === "1";
  const offlineEnabled = process.env.EXPO_PUBLIC_PURAMA_OFFLINE_QUALIFICATION === "1";
  const runId = process.env.EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION_RUN_ID;
  const commit = process.env.EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION_COMMIT;
  if (!enabled) return Promise.reject(new DigestQualificationError("qualification-disabled"));
  if (offlineEnabled) return Promise.reject(new DigestQualificationError("qualification-conflict"));
  if (typeof runId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId)
      || typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    return Promise.reject(new DigestQualificationError("qualification-identity-invalid"));
  }
  // StrictMode may mount the route twice; one process owns one receipt.
  running ??= qualifyDigest(runId, commit, onStatus);
  return running;
}

async function qualifyDigest(runId: string, commit: string, onStatus?: (status: string) => void): Promise<IaoDigestQualificationReceipt> {
  const startedAt = performance.now();
  const checks: Record<string, boolean> = Object.fromEntries(contract.checks.map(name => [name, false]));
  const rawDigests: Sha256Digest[] = [];
  let adapter: IaoLocalDigest | undefined;
  let fileSystem: typeof import("expo-file-system") | undefined;
  let platform: IaoDigestQualificationReceipt["platform"] = "unknown";
  let engine: IaoDigestQualificationReceipt["engine"] = "unknown";
  let bundleSource: IaoDigestQualificationReceipt["bundleSource"] = "unknown";
  let backend: IaoDigestQualificationReceipt["backend"] = "unknown";
  let failed = false;
  let failure: unknown;
  const rememberFailure = (error: unknown) => {
    if (!failed) { failed = true; failure = error; }
  };

  try {
    fileSystem = await import("expo-file-system");
    const { Platform, NativeModules, TurboModuleRegistry } = await import("./iao-digest-qualification-runtime");
    if (Platform.OS === "ios" || Platform.OS === "android" || Platform.OS === "web") platform = Platform.OS;
    requireCheck(platform === "ios", "ios-required");
    const hermes = (globalThis as typeof globalThis & { HermesInternal?: unknown }).HermesInternal;
    requireCheck(hermes !== null && typeof hermes === "object", "hermes-required");
    engine = "hermes";
    type SourceCodeModule = import("react-native").TurboModule & { getConstants(): { scriptURL: string } };
    const sourceCode = TurboModuleRegistry.get<SourceCodeModule>("SourceCode") ?? NativeModules.SourceCode;
    const scriptURL: unknown = typeof sourceCode?.getConstants === "function"
      ? sourceCode.getConstants().scriptURL : sourceCode?.scriptURL;
    requireCheck(typeof scriptURL === "string" && !scriptURL.includes("\0")
      && /^file:\/\/\/[^?#\r\n]+\.app\/main\.jsbundle$/.test(scriptURL),
      "embedded-bundle-required");
    bundleSource = "embedded";
    onStatus?.("Vérification du module SHA-256 natif dans Hermes sur iOS…");
    const { getPuramaLocalDigestModule, MAX_DIGEST_BLOCK_BYTES } = await import("../modules/purama-local-digest/index");
    const native = getPuramaLocalDigestModule();
    requireCheck(native !== null && MAX_DIGEST_BLOCK_BYTES === MAX_BLOCK_BYTES, "native-digest-required");
    backend = "native-sha256";
    const makeDigest = () => {
      const digest = new native.Sha256Digest();
      rawDigests.push(digest);
      return digest;
    };

    requireCheck(makeDigest().digestHex() === EMPTY, "empty-vector-failed");
    checks.emptyVector = true;

    const offset = makeDigest();
    offset.update(new Uint8Array([0, 97, 98, 99, 255]).subarray(1, 4));
    requireCheck(offset.digestHex() === ABC, "offset-vector-failed");
    checks.offsetViewVector = true;
    rejected(() => offset.update(new Uint8Array([120])), "finalized-update-accepted");
    rejected(() => offset.digestHex(), "second-finalization-accepted");
    checks.finalizedStateRejected = true;

    const split = makeDigest();
    for (const bytes of [new Uint8Array([97]), new Uint8Array(), new Uint8Array([98]), new Uint8Array([99])]) split.update(bytes);
    requireCheck(split.digestHex() === ABC, "split-vector-failed");
    checks.splitVector = true;

    const block = new Uint8Array(MAX_BLOCK_BYTES).fill(97);
    const maximum = makeDigest();
    maximum.update(block);
    requireCheck(maximum.digestHex() === BLOCK_A, "maximum-block-vector-failed");
    checks.maximumBlockVector = true;
    const multi = makeDigest();
    for (let remaining = 1_000_000; remaining > 0; remaining -= MAX_BLOCK_BYTES) {
      multi.update(block.subarray(0, Math.min(remaining, MAX_BLOCK_BYTES)));
    }
    requireCheck(multi.digestHex() === MILLION_A, "multi-block-vector-failed");
    checks.multiBlockVector = true;

    const source = new Uint8Array([97, 98]);
    const consumed = makeDigest();
    consumed.update(source);
    source.fill(122);
    consumed.update(new Uint8Array([99]));
    requireCheck(consumed.digestHex() === ABC, "synchronous-consumption-failed");
    checks.synchronousConsumption = true;

    const unsupported: unknown[] = [new Int8Array(1), new Uint8ClampedArray(1), new Int16Array(1), new Uint16Array(1),
      new Int32Array(1), new Uint32Array(1), new Float32Array(1), new Float64Array(1),
      new DataView(new ArrayBuffer(1)), new ArrayBuffer(1), [97], null];
    for (const input of unsupported) {
      // Exercise Expo's actual native argument conversion, not the JS adapter guard.
      const digest = makeDigest();
      rejected(() => digest.update(input as Uint8Array), "unsupported-type-accepted");
    }
    checks.unsupportedTypesRejected = true;

    const oversized = makeDigest();
    rejected(() => oversized.update(new Uint8Array(MAX_BLOCK_BYTES + 1)), "oversized-block-accepted");
    oversized.update(new Uint8Array([97, 98, 99]));
    requireCheck(oversized.digestHex() === ABC, "oversized-block-altered-state");
    checks.oversizedBlockRejected = true;

    const destroyed = makeDigest();
    destroyed.update(new Uint8Array([97]));
    destroyed.destroy();
    destroyed.destroy();
    checks.destroyIsIdempotent = true;
    rejected(() => destroyed.update(new Uint8Array([98])), "destroyed-update-accepted");
    rejected(() => destroyed.digestHex(), "destroyed-finalization-accepted");
    checks.destroyedStateRejected = true;

    const { createIaoLocalDigest } = await import("./iao-local-digest");
    adapter = await createIaoLocalDigest();
    requireCheck(adapter.implementation === "native-sha256", "native-adapter-required");
    checks.adapterNativeRequired = true;
    adapter.update(new Uint8Array([255, 97, 98, 99, 0]).subarray(1, 4));
    requireCheck(adapter.digestHex() === ABC, "adapter-offset-vector-failed");
    checks.adapterOffsetViewVector = true;
  } catch (error) { rememberFailure(error); }

  let released = 0;
  for (const digest of rawDigests) {
    try { digest.destroy(); } catch (error) { rememberFailure(error); }
    try { digest.release(); released++; } catch (error) { rememberFailure(error); }
    // Never call a native method on this SharedObject after release().
  }
  checks.nativeReleaseCompleted = rawDigests.length > 0 && released === rawDigests.length;
  if (adapter) {
    try {
      adapter.destroy();
      adapter.destroy(); // The adapter owns its release and must keep cleanup idempotent.
      checks.adapterCleanupCompleted = true;
    } catch (error) { rememberFailure(error); }
  }
  if (!failed && !contract.checks.every(name => checks[name] === true)) {
    rememberFailure(new DigestQualificationError("qualification-incomplete"));
  }
  try {
    onStatus?.(failed ? "La qualification native iOS a échoué." : "Qualification SHA-256 native iOS terminée.");
  } catch (error) { rememberFailure(error); }
  const receipt: IaoDigestQualificationReceipt = Object.freeze({
    schema: 1, status: failed ? "FAIL" : "PASS", runId, commit, platform, engine, bundleSource, backend,
    checks: Object.freeze(checks), elapsedMs: Math.round(performance.now() - startedAt), completedAt: new Date().toISOString(),
    errorCode: failed ? (failure instanceof DigestQualificationError ? failure.code : "native-digest-qualification-failed") : null,
  });
  requireCheck(fileSystem !== undefined, "receipt-unavailable");
  const receiptFile = new fileSystem.File(fileSystem.Paths.document, contract.receiptFile);
  requireCheck(!receiptFile.exists, "receipt-already-exists");
  const pendingFile = new fileSystem.File(fileSystem.Paths.document, `${contract.receiptFile}.${runId}.pending`);
  const serialized = JSON.stringify(receipt);
  // The host observes only the final name. No empty/partial final receipt is
  // created; an interrupted temporary stays diagnostic in the disposable app.
  pendingFile.create({ overwrite: false });
  pendingFile.write(serialized);
  requireCheck(pendingFile.textSync() === serialized, "receipt-write-mismatch");
  pendingFile.move(receiptFile);
  return receipt;
}
