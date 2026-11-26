import { createIaoLocalDigest } from "./iao-local-digest";
import type { IaoLocalDigest } from "./iao-local-digest";
import { IAO_LOCAL_PACK_MANIFEST } from "./iao-local-manifest";
import type { IaoLocalPackAsset, IaoLocalPackManifest } from "./iao-local-manifest";
import { MAX_DIGEST_BLOCK_BYTES } from "../modules/purama-local-digest/contract";

export type IaoLocalErrorCode = "aborted" | "busy" | "pack-absent" | "integrity" | "storage"
  | "download" | "unsupported" | "memory" | "native" | "timeout" | "context-limit"
  | "invalid-message" | "invalid-output" | "restart-required";

const ERROR_MESSAGES: Record<IaoLocalErrorCode, string> = {
  aborted: "Opération locale arrêtée.",
  busy: "PURAMA termine une opération locale. Réessayez ensuite.",
  "pack-absent": "Préparez PURAMA sur cet appareil avant de l’utiliser hors connexion.",
  integrity: "Le pack local n’a pas passé le contrôle d’intégrité. Préparez-le de nouveau.",
  storage: "L’espace disponible ou l’accès au stockage ne permet pas de préparer PURAMA.",
  download: "La préparation n’a pas abouti. Vérifiez la connexion puis réessayez.",
  unsupported: "Le moteur local nécessite une application PURAMA native compatible.",
  memory: "Cet appareil ne satisfait pas le seuil de mémoire de ce pack local.",
  native: "Le moteur local n’a pas pu terminer cette opération.",
  timeout: "L’opération locale a dépassé sa durée maximale et a été arrêtée.",
  "context-limit": "Ce message dépasse la capacité du pack local. Réduisez sa longueur.",
  "invalid-message": "Ce message ne peut pas être traité par le moteur local.",
  "invalid-output": "Le moteur local n’a pas produit de réponse exploitable.",
  "restart-required": "Le moteur local doit être réinitialisé en redémarrant l’application.",
};

export class IaoLocalError extends Error {
  readonly code: IaoLocalErrorCode;
  constructor(code: IaoLocalErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "IaoLocalError";
    this.code = code;
  }
}

export function assertIaoLocalActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new IaoLocalError("aborted");
}

export type IaoLocalPackState = Readonly<{
  status: "absent" | "downloading" | "verifying" | "ready" | "error";
  progress: number;
  completedBytes: number;
  totalBytes: number;
  phase?: "download" | "integrity" | "local-test";
  errorCode?: IaoLocalErrorCode;
  message?: string;
}>;

export type IaoLocalPackReady = Readonly<{
  packId: string;
  modelUri: string;
  licenseUri: string;
  modelVersion: string;
}>;

export type IaoLocalProgress = (state: IaoLocalPackState) => void;
export type IaoLocalSmokeTest = (modelUri: string, signal?: AbortSignal) => Promise<void>;
type Stat = Readonly<{ exists: boolean; bytes: number; modified: number | null }>;
type ReadHandle = { readBytes(length: number): Uint8Array; close(): void };
type WriteHandle = { writeBytes(bytes: Uint8Array): void; close(): void };

/** A narrow, injectable file boundary; the production implementation uses SDK 54 FileHandle. */
export interface IaoLocalPackStorage {
  ensureRoot(): void;
  availableBytes(): number;
  directoryExists(path: string): boolean;
  createDirectory(path: string): void;
  removeDirectory(path: string): void;
  moveDirectory(source: string, destination: string): void | Promise<void>;
  stat(path: string): Stat;
  openRead(path: string): ReadHandle;
  openWrite(path: string): WriteHandle;
  readText(path: string, maximumBytes: number): string;
  writeText(path: string, text: string): void;
  uri(path: string): string;
}

export type IaoLocalPackDependencies = Readonly<{
  smokeTest: IaoLocalSmokeTest;
  storage?: () => Promise<IaoLocalPackStorage>;
  download?: (asset: IaoLocalPackAsset, writer: WriteHandle, signal: AbortSignal | undefined,
    onBytes: (bytes: number) => void) => Promise<void>;
  manifest?: IaoLocalPackManifest;
  yieldToUI?: () => Promise<void>;
  createDigest?: () => IaoLocalDigest | Promise<IaoLocalDigest>;
}>;

export interface IaoLocalPack {
  getState(): IaoLocalPackState;
  subscribe(listener: IaoLocalProgress): () => void;
  /** Local files only. First call in a process rehashes both assets and performs a real smoke test. */
  inspect(signal?: AbortSignal, onProgress?: IaoLocalProgress): Promise<IaoLocalPackState>;
  /** The only path allowed to download; invoked by an explicit preparation action. */
  prepare(signal?: AbortSignal, onProgress?: IaoLocalProgress): Promise<IaoLocalPackReady>;
  requireReady(signal?: AbortSignal): Promise<IaoLocalPackReady>;
}

const BLOCK_BYTES = MAX_DIGEST_BLOCK_BYTES;
const RECEIPT_NAME = "prepared.json";
const RECEIPT_LIMIT = 8192;

/** Creating the controller does not load native modules, read storage, or access a network. */
export function createIaoLocalPack(dependencies: IaoLocalPackDependencies): IaoLocalPack {
  const manifest = dependencies.manifest ?? IAO_LOCAL_PACK_MANIFEST;
  const assets = [manifest.model, manifest.licenseFile];
  const totalBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  const folder = manifest.id;
  const staging = `${folder}.partial`;
  const receipt = JSON.stringify({ schema: manifest.schema, packId: manifest.id,
    repository: manifest.repository, revision: manifest.revision, runtime: manifest.runtime,
    modelSha256: manifest.model.sha256, modelBytes: manifest.model.bytes,
    licenseSha256: manifest.licenseFile.sha256, licenseBytes: manifest.licenseFile.bytes,
    smokeVersion: manifest.smokeVersion });
  const yieldToUI = dependencies.yieldToUI ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  let state: IaoLocalPackState = Object.freeze({ status: "absent", progress: 0, completedBytes: 0, totalBytes });
  const listeners = new Set<IaoLocalProgress>();
  let storagePromise: Promise<IaoLocalPackStorage> | undefined;
  let ready: IaoLocalPackReady | undefined;
  let verifiedFingerprint: string | undefined;
  let busy = false;

  function publish(next: Partial<IaoLocalPackState> & Pick<IaoLocalPackState, "status">, observer?: IaoLocalProgress) {
    state = Object.freeze({ progress: 0, completedBytes: 0, totalBytes, ...next });
    for (const listener of [...listeners, ...(observer ? [observer] : [])]) {
      try { listener(state); } catch { /* UI observers cannot interrupt a file transaction. */ }
    }
  }

  async function storage(): Promise<IaoLocalPackStorage> {
    if (!storagePromise) storagePromise = (dependencies.storage ?? createExpoPackStorage)().catch(error => {
      storagePromise = undefined;
      throw error instanceof IaoLocalError ? error : new IaoLocalError("storage");
    });
    return storagePromise;
  }

  function fingerprint(fs: IaoLocalPackStorage): string {
    return JSON.stringify([...assets.map(asset => fs.stat(`${folder}/${asset.name}`)), fs.stat(`${folder}/${RECEIPT_NAME}`)]);
  }

  function hasModificationTime(stat: Stat): boolean {
    return stat.modified !== null && Number.isFinite(stat.modified);
  }

  function sameStat(checked: Stat, current: Stat): boolean {
    return checked.exists && current.exists && hasModificationTime(checked) && hasModificationTime(current) &&
      checked.bytes === current.bytes && checked.modified === current.modified;
  }

  function assertVerifiedAssets(fs: IaoLocalPackStorage, directory: string, checked: readonly Stat[]): void {
    if (checked.length !== assets.length || assets.some((asset, index) =>
      !sameStat(checked[index], fs.stat(`${directory}/${asset.name}`)))) throw new IaoLocalError("integrity");
  }

  async function verifyAsset(fs: IaoLocalPackStorage, directory: string, asset: IaoLocalPackAsset,
    completedBefore: number, signal?: AbortSignal, observer?: IaoLocalProgress): Promise<Stat> {
    assertIaoLocalActive(signal);
    const path = `${directory}/${asset.name}`;
    const before = fs.stat(path);
    if (!before.exists || before.bytes !== asset.bytes) throw new IaoLocalError("integrity");
    if (!hasModificationTime(before)) throw new IaoLocalError("storage");
    let handle: ReadHandle | undefined;
    let digest: IaoLocalDigest | undefined;
    let failed = false;
    let failure: unknown;
    let read = 0;
    try {
      digest = await (dependencies.createDigest ?? createIaoLocalDigest)();
      assertIaoLocalActive(signal);
      handle = fs.openRead(path);
      while (read < asset.bytes) {
        assertIaoLocalActive(signal);
        const count = Math.min(BLOCK_BYTES, asset.bytes - read);
        const bytes = handle.readBytes(count);
        if (!(bytes instanceof Uint8Array) || bytes.length !== count) throw new IaoLocalError("integrity");
        if (read === 0 && asset.name === manifest.model.name &&
            (bytes[0] !== 0x47 || bytes[1] !== 0x47 || bytes[2] !== 0x55 || bytes[3] !== 0x46)) {
          throw new IaoLocalError("integrity");
        }
        digest.update(bytes);
        read += bytes.length;
        publish({ status: "verifying", phase: "integrity", completedBytes: completedBefore + read,
          progress: (completedBefore + read) / totalBytes }, observer);
        // Bounded native reads plus a real task yield keep cancellation and the UI responsive.
        await yieldToUI();
      }
      assertIaoLocalActive(signal);
      const after = fs.stat(path);
      if (!sameStat(before, after) ||
          digest.digestHex() !== asset.sha256) throw new IaoLocalError("integrity");
    } catch (error) {
      failed = true;
      failure = error;
    }
    // Attempt both cleanups, including when creation/opening failed. Preserve
    // the first failure, even when its thrown value is undefined.
    try { digest?.destroy(); }
    catch (error) { if (!failed) { failed = true; failure = error; } }
    try { handle?.close(); }
    catch (error) { if (!failed) { failed = true; failure = error; } }
    if (failed) throw failure;
    return Object.freeze({ ...before });
  }

  function readReceipt(fs: IaoLocalPackStorage): Stat {
    const path = `${folder}/${RECEIPT_NAME}`;
    const before = fs.stat(path);
    if (!before.exists || before.bytes > RECEIPT_LIMIT) throw new IaoLocalError("integrity");
    if (!hasModificationTime(before)) throw new IaoLocalError("storage");
    const text = fs.readText(path, RECEIPT_LIMIT);
    if (text !== receipt || !sameStat(before, fs.stat(path))) throw new IaoLocalError("integrity");
    return Object.freeze({ ...before });
  }

  function markReady(fs: IaoLocalPackStorage, checked: readonly Stat[], observer?: IaoLocalProgress): IaoLocalPackReady {
    const checkedReceipt = readReceipt(fs);
    assertVerifiedAssets(fs, folder, checked);
    ready = Object.freeze({ packId: manifest.id, modelUri: fs.uri(`${folder}/${manifest.model.name}`),
      licenseUri: fs.uri(`${folder}/${manifest.licenseFile.name}`),
      modelVersion: `${manifest.repository}@${manifest.revision}:${manifest.model.sha256}` });
    // Retain the metadata that accompanied the successful hashes, never adopt
    // newly changed files after smoke or asynchronous directory promotion.
    // Missing modification times have already refused verification/promotion.
    verifiedFingerprint = JSON.stringify([...checked, checkedReceipt]);
    publish({ status: "ready", progress: 1, completedBytes: totalBytes }, observer);
    return ready;
  }

  async function installed(fs: IaoLocalPackStorage, signal?: AbortSignal, observer?: IaoLocalProgress): Promise<IaoLocalPackReady | undefined> {
    assertIaoLocalActive(signal);
    if (!fs.directoryExists(folder)) {
      ready = undefined;
      verifiedFingerprint = undefined;
      publish({ status: "absent" }, observer);
      return undefined;
    }
    readReceipt(fs);
    if (ready && verifiedFingerprint === fingerprint(fs)) {
      publish({ status: "ready", progress: 1, completedBytes: totalBytes }, observer);
      return ready;
    }
    ready = undefined;
    verifiedFingerprint = undefined;
    let completed = 0;
    const checked: Stat[] = [];
    for (const asset of assets) {
      checked.push(await verifyAsset(fs, folder, asset, completed, signal, observer));
      completed += asset.bytes;
    }
    publish({ status: "verifying", phase: "local-test", progress: 1, completedBytes: totalBytes }, observer);
    assertVerifiedAssets(fs, folder, checked);
    await dependencies.smokeTest(fs.uri(`${folder}/${manifest.model.name}`), signal);
    assertIaoLocalActive(signal);
    return markReady(fs, checked, observer);
  }

  async function operation<T>(action: () => Promise<T>, observer?: IaoLocalProgress): Promise<T> {
    if (busy) throw new IaoLocalError("busy");
    busy = true;
    try { return await action(); }
    catch (error) {
      ready = undefined;
      verifiedFingerprint = undefined;
      const safe = error instanceof IaoLocalError ? error : new IaoLocalError("storage");
      publish({ status: "error", errorCode: safe.code, message: safe.message }, observer);
      throw safe;
    } finally { busy = false; }
  }

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    inspect(signal, observer) {
      return operation(async () => { await installed(await storage(), signal, observer); return state; }, observer);
    },
    requireReady(signal) {
      return operation(async () => {
        const result = await installed(await storage(), signal);
        if (!result) throw new IaoLocalError("pack-absent");
        return result;
      });
    },
    prepare(signal, observer) {
      return operation(async () => {
        assertIaoLocalActive(signal);
        const fs = await storage();
        fs.ensureRoot();
        try {
          const existing = await installed(fs, signal, observer);
          if (existing) return existing;
        } catch (error) {
          // An explicit preparation may repair an invalid pack. Native failure/abort
          // must never be converted to an unnecessary network download.
          if (!(error instanceof IaoLocalError) || error.code !== "integrity") throw error;
        }
        assertIaoLocalActive(signal);
        fs.removeDirectory(staging);
        const free = fs.availableBytes();
        if (!Number.isFinite(free) || free < totalBytes + manifest.storageReserveBytes) throw new IaoLocalError("storage");
        fs.createDirectory(staging);
        let promoted = false;
        try {
          let completed = 0;
          const checked: Stat[] = [];
          for (const asset of assets) {
            assertIaoLocalActive(signal);
            publish({ status: "downloading", phase: "download", completedBytes: completed,
              progress: completed / totalBytes }, observer);
            const writer = fs.openWrite(`${staging}/${asset.name}`);
            try {
              await (dependencies.download ?? downloadExpoAsset)(asset, writer, signal, bytes => {
                if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > asset.bytes) throw new IaoLocalError("download");
                publish({ status: "downloading", phase: "download", completedBytes: completed + bytes,
                  progress: (completed + bytes) / totalBytes }, observer);
              });
            } finally { writer.close(); }
            checked.push(await verifyAsset(fs, staging, asset, completed, signal, observer));
            completed += asset.bytes;
          }
          publish({ status: "verifying", phase: "local-test", progress: 1, completedBytes: totalBytes }, observer);
          assertVerifiedAssets(fs, staging, checked);
          await dependencies.smokeTest(fs.uri(`${staging}/${manifest.model.name}`), signal);
          assertIaoLocalActive(signal);
          assertVerifiedAssets(fs, staging, checked);
          fs.writeText(`${staging}/${RECEIPT_NAME}`, receipt);
          // No reader trusts a staging directory. The prepared receipt and both
          // verified assets are promoted together by one same-parent native move.
          fs.removeDirectory(folder);
          await fs.moveDirectory(staging, folder);
          promoted = true;
          assertIaoLocalActive(signal);
          return markReady(fs, checked, observer);
        } finally {
          if (!promoted) fs.removeDirectory(staging);
        }
      }, observer);
    },
  };
}

async function createExpoPackStorage(): Promise<IaoLocalPackStorage> {
  let module: typeof import("expo-file-system");
  try { module = await import("expo-file-system"); }
  catch { throw new IaoLocalError("unsupported"); }
  const { Directory, File, Paths } = module;
  const root = new Directory(Paths.document, "purama-iao-packs");
  const file = (path: string) => new File(root, path);
  const directory = (path: string) => new Directory(root, path);
  return {
    ensureRoot: () => root.create({ idempotent: true, intermediates: true }),
    availableBytes: () => Paths.availableDiskSpace,
    directoryExists: path => directory(path).exists,
    createDirectory: path => directory(path).create({ intermediates: false, idempotent: false }),
    removeDirectory(path) { const target = directory(path); if (target.exists) target.delete(); },
    async moveDirectory(source, destination) {
      // SDK 54's modern Directory.move uses copy/delete on Android API 24–25.
      // The legacy entry point in the same package uses native renameTo for
      // file:// paths on every supported Android version (same parent/volume).
      const { moveAsync } = await import("expo-file-system/legacy");
      await moveAsync({ from: directory(source).uri, to: directory(destination).uri });
    },
    stat(path) { const target = file(path); return { exists: target.exists, bytes: target.size, modified: target.modificationTime }; },
    openRead: path => file(path).open(),
    openWrite(path) { const target = file(path); target.create({ overwrite: false }); return target.open(); },
    readText(path, maximumBytes) {
      const target = file(path);
      if (!target.exists || target.size > maximumBytes) throw new IaoLocalError("integrity");
      return target.textSync();
    },
    writeText(path, text) { const target = file(path); target.create({ overwrite: false }); target.write(text); },
    uri: path => file(path).uri,
  };
}

async function downloadExpoAsset(asset: IaoLocalPackAsset, writer: WriteHandle,
  signal: AbortSignal | undefined, onBytes: (bytes: number) => void): Promise<void> {
  assertIaoLocalActive(signal);
  // Expo's streaming fetch accepts AbortSignal. File.downloadFileAsync in SDK 54
  // does not, so it must not be used for this cancellable large-file operation.
  const { fetch } = await import("expo/fetch");
  const controller = new AbortController();
  let idleTimeout: ReturnType<typeof setTimeout> | undefined;
  const forward = () => controller.abort();
  signal?.addEventListener("abort", forward, { once: true });
  if (signal?.aborted) controller.abort();
  const resetTimeout = () => {
    if (idleTimeout) clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => controller.abort(), 90_000);
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    resetTimeout();
    const response = await fetch(asset.url, { signal: controller.signal, credentials: "omit", redirect: "follow" });
    if (response.status !== 200 || !response.body) throw new IaoLocalError("download");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== asset.bytes)) throw new IaoLocalError("download");
    reader = response.body.getReader();
    let received = 0;
    while (true) {
      assertIaoLocalActive(signal);
      resetTimeout();
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || received + value.length > asset.bytes) throw new IaoLocalError("download");
      for (let offset = 0; offset < value.length; offset += BLOCK_BYTES) {
        assertIaoLocalActive(signal);
        writer.writeBytes(value.subarray(offset, offset + BLOCK_BYTES));
      }
      received += value.length;
      onBytes(received);
    }
    assertIaoLocalActive(signal);
    if (received !== asset.bytes) throw new IaoLocalError("download");
  } catch (error) {
    throw signal?.aborted ? new IaoLocalError("aborted")
      : error instanceof IaoLocalError ? error : new IaoLocalError("download");
  } finally {
    controller.abort();
    if (idleTimeout) clearTimeout(idleTimeout);
    signal?.removeEventListener("abort", forward);
    try { await reader?.cancel(); } catch { /* The fetch may already have aborted. */ }
    reader?.releaseLock();
  }
}
