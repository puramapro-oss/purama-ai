/**
 * Device qualification only. No account grant, authentication bypass, remote SQL
 * or mocked engine/storage implementation. The route imports this module only
 * in a binary built with the exact public qualification flag below.
 */
import type { SmaranaConversationSnapshot } from "../../shared/smarana";
import type { IaoLocalCompletion } from "./iao-local-engine";

export type IaoNativeQualificationReceipt = Readonly<Record<string, unknown> & {
  schema: 1;
  phase: "prepared" | "complete" | "failed";
  status: "PASS" | "FAIL";
}>;

const MARKER = "PURAMA_OFFLINE_QUALIFICATION:";
const PROGRESS_MARKER = "PURAMA_OFFLINE_QUALIFICATION_PROGRESS:";
const CHECKPOINT = "purama-native-qualification.json";
const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const SQL_HEADER = "SQLite format 3\u0000";
let running: Promise<IaoNativeQualificationReceipt> | undefined;

type PreparedCheckpoint = {
  schema: 1;
  phase: "prepared";
  runId: string;
  resourceId: string;
  pendingId: string;
  firstAnswerHash: string;
};

class QualificationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "QualificationError"; }
}

function requireCheck(condition: unknown, code: string): asserts condition {
  if (!condition) throw new QualificationError(code);
}

function emit(receipt: IaoNativeQualificationReceipt): IaoNativeQualificationReceipt {
  // Fixtures only. Never pass a native exception, database key, token, or real
  // account information into this logcat-visible evidence channel.
  console.log(`${MARKER}${JSON.stringify(receipt)}`);
  return receipt;
}

function qualificationEnabled(): boolean {
  return process.env.EXPO_PUBLIC_PURAMA_OFFLINE_QUALIFICATION === "1";
}

export function runIaoNativeQualification(onStatus?: (status: string) => void): Promise<IaoNativeQualificationReceipt> {
  if (!qualificationEnabled()) return Promise.reject(new QualificationError("qualification-disabled"));
  // React StrictMode may mount the QA screen twice. One process performs one
  // qualification phase; the second phase requires an actual process restart.
  running ??= runPhase(onStatus);
  return running;
}

async function runPhase(onStatus?: (status: string) => void): Promise<IaoNativeQualificationReceipt> {
  requireCheck(qualificationEnabled(), "qualification-disabled");
  let phase: "prepared" | "complete" = "prepared";
  let runId: string | undefined;
  const startedAt = performance.now();
  let stageStartedAt = startedAt;
  let stage = "initializing";
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let restoreNetwork: (() => void) | undefined;
  let engine: import("./iao-local-engine").IaoLocalEngine | undefined;
  let closeStore: (() => Promise<void>) | undefined;
  let unsubscribePack: (() => void) | undefined;
  const progress = (pack?: { status: string; phase?: string; progressPercent: number }) => {
    // Only fixed stage names and bounded numeric metadata. No prompts, tokens,
    // storage keys or native exception text enter the diagnostic channel.
    console.log(`${PROGRESS_MARKER}${JSON.stringify({ schema: 1, phase, stage, runId,
      elapsedMs: Math.round(performance.now() - startedAt), ...(pack ? { pack } : {}) })}`);
  };
  const beginStage = (next: string, status: string) => {
    stage = next;
    stageStartedAt = performance.now();
    onStatus?.(status);
    progress();
  };
  try {
    const [{ File, Paths }, crypto, device, { Platform }, { isSmaranaUuid }] = await Promise.all([
      import("expo-file-system"), import("expo-crypto"), import("expo-device"), import("react-native"), import("../../shared/smarana"),
    ]);
    requireCheck(Platform.OS === "android", "android-required");
    const checkpointFile = new File(Paths.document, CHECKPOINT);
    let checkpoint: PreparedCheckpoint | undefined;
    if (checkpointFile.exists) {
      requireCheck(checkpointFile.size <= 8192, "invalid-checkpoint");
      const value = JSON.parse(checkpointFile.textSync()) as Partial<PreparedCheckpoint>;
      requireCheck(value.schema === 1 && value.phase === "prepared" && isSmaranaUuid(value.runId) &&
        isSmaranaUuid(value.resourceId) && isSmaranaUuid(value.pendingId) &&
        typeof value.firstAnswerHash === "string" && /^[0-9a-f]{64}$/.test(value.firstAnswerHash), "invalid-checkpoint");
      checkpoint = value as PreparedCheckpoint;
      phase = "complete";
      runId = checkpoint.runId;
    } else runId = crypto.randomUUID();
    // Includes import/bootstrap time. The complete phase is refined from the
    // engine's finite verification/inference budgets once the module is loaded.
    let phaseDeadline = startedAt + (checkpoint ? 900_000 : 600_000);
    timer = setTimeout(() => controller.abort(), Math.max(0, phaseDeadline - performance.now()));
    const active = () => {
      if (performance.now() >= phaseDeadline) controller.abort();
      requireCheck(!controller.signal.aborted, "qualification-timeout");
    };
    const fixtureMarker = `PURAMA_QA_PERSISTED_${runId}`;
    const userPrompt = "Réponds en français avec un seul mot : Bonjour.";
    let unexpectedNetworkCalls = 0;
    if (checkpoint) {
      beginStage("network-guard", "Qualification après redémarrage : réseau JavaScript interdit.");
      const denied = () => { unexpectedNetworkCalls += 1; throw new QualificationError("unexpected-js-network"); };
      const originals = ["fetch", "XMLHttpRequest", "WebSocket"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
      Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: denied });
      const ForbiddenNetwork = class { constructor() { denied(); } };
      Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, writable: true, value: ForbiddenNetwork });
      Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: ForbiddenNetwork });
      restoreNetwork = () => {
        for (const [name, descriptor] of originals) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else Reflect.deleteProperty(globalThis, name);
        }
      };
    }

    const [local, smarana] = await Promise.all([import("./iao-local-engine"), import("./smarana-native")]);
    engine = local.getIaoLocalEngine();
    closeStore = smarana.closeSmaranaStore;
    clearTimeout(timer);
    const phaseBudget = checkpoint
      ? local.IAO_LOCAL_ENGINE_BUDGETS.verificationMs + local.IAO_LOCAL_ENGINE_BUDGETS.inferenceMs + 60_000
      : 600_000;
    phaseDeadline = startedAt + phaseBudget;
    timer = setTimeout(() => controller.abort(), Math.max(0, phaseDeadline - performance.now()));
    let lastPackProgress = "";
    unsubscribePack = engine.subscribe(state => {
      const progressPercent = Math.max(0, Math.min(100, Math.floor(state.progress * 100)));
      const bucket = `${stage}:${state.status}:${state.phase}:${Math.floor(progressPercent / 10)}`;
      if (bucket === lastPackProgress) return;
      lastPackProgress = bucket;
      progress({ status: state.status, phase: state.phase, progressPercent });
    });
    beginStage("integrity-backend", "Vérification du calcul d’intégrité natif.");
    const { createIaoLocalDigest } = await import("./iao-local-digest");
    const digest = await createIaoLocalDigest();
    let digestFailed = false;
    let digestFailure: unknown;
    try {
      requireCheck(digest.implementation === "native-sha256", "native-sha256-required");
      // Exercise the actual Expo TypedArray bridge, including a nonzero view
      // offset. The core tests separately cover large blocks and lifecycle.
      const sentinel = new Uint8Array([0, 97, 98, 99, 255]);
      digest.update(sentinel.subarray(1, 4));
      requireCheck(digest.digestHex() === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        "native-sha256-self-test-failed");
    } catch (error) { digestFailed = true; digestFailure = error; }
    try { digest.destroy(); }
    catch (error) { if (!digestFailed) { digestFailed = true; digestFailure = error; } }
    if (digestFailed) throw digestFailure;
    active();
    const common = {
      runId,
      fixtureAccountsOnly: true,
      platform: Platform.OS,
      reportedTotalMemoryBytes: device.totalMemory,
      requiredMemoryBytes: local.IAO_LOCAL_PACK_MANIFEST.minimumMemoryBytes,
      model: { repository: local.IAO_LOCAL_PACK_MANIFEST.repository, revision: local.IAO_LOCAL_PACK_MANIFEST.revision,
        bytes: local.IAO_LOCAL_PACK_MANIFEST.model.bytes, sha256: local.IAO_LOCAL_PACK_MANIFEST.model.sha256 },
      integrity: { implementation: digest.implementation, offsetViewVectorVerified: true },
    };
    const checkNative = (completion: IaoLocalCompletion) => {
      requireCheck(completion.native.backend === "llama.rn" && completion.native.gpu === false &&
        completion.native.modelSha256 === local.IAO_LOCAL_PACK_MANIFEST.model.sha256 &&
        completion.text.trim().length > 0 && completion.tokensGenerated > 0, "native-evidence-missing");
    };

    if (!checkpoint) {
      beginStage("pack-preparation", "Préparation du pack officiel puis essai du moteur natif.");
      let lastProgress = "";
      await engine.prepare(controller.signal, state => {
        const progress = `${state.status}:${state.phase}:${Math.floor(state.progress * 100)}`;
        if (lastProgress === progress) return;
        lastProgress = progress;
        onStatus?.(`Préparation native : ${state.phase ?? state.status} ${Math.floor(state.progress * 100)} %`);
      });
      active();
      beginStage("native-completion", "Première génération réelle sur le moteur natif.");
      const answer = await engine.complete([{ role: "user", content: userPrompt }], { signal: controller.signal });
      checkNative(answer);
      beginStage("fixture-storage", "Enregistrement des données synthétiques chiffrées.");
      const store = await smarana.openSmaranaStore(OWNER_A);
      active();
      const now = new Date().toISOString();
      const pendingId = crypto.randomUUID();
      const payload: SmaranaConversationSnapshot = {
        title: "Qualification native PURAMA — données synthétiques",
        draft: `${fixtureMarker}\nBrouillon exact : éàç, مرحبا, 👋`,
        messages: [
          { id: crypto.randomUUID(), role: "user", content: userPrompt, state: "complete", createdAt: now },
          { id: crypto.randomUUID(), role: "assistant", content: answer.text, state: "complete", createdAt: now },
          { id: crypto.randomUUID(), role: "user", content: "Reprise après interruption, donnée de test.", state: "complete", createdAt: now },
          { id: pendingId, role: "assistant", content: `${fixtureMarker}:réponse-partielle`, state: "pending", createdAt: now },
        ],
      };
      const saved = await store.create(payload);
      requireCheck(saved.syncState === "pending" && saved.payload?.draft === payload.draft, "initial-save-failed");
      await smarana.closeSmaranaStore();
      active();
      const next: PreparedCheckpoint = { schema: 1, phase: "prepared", runId, resourceId: saved.resourceId, pendingId,
        firstAnswerHash: await crypto.digestStringAsync(crypto.CryptoDigestAlgorithm.SHA256, answer.text) };
      checkpointFile.create({ overwrite: false });
      checkpointFile.write(JSON.stringify(next));
      requireCheck(checkpointFile.textSync() === JSON.stringify(next), "checkpoint-write-failed");
      await engine.release();
      active();
      onStatus?.("Phase préparée. Le script doit maintenant fermer l’application et couper le réseau.");
      return emit({ schema: 1, phase: "prepared", status: "PASS", ...common,
        elapsedMs: Math.round(performance.now() - startedAt),
        backend: answer.native.backend, gpu: answer.native.gpu,
        nativeOutput: answer.text.slice(0, 256), tokensGenerated: answer.tokensGenerated,
        resourceId: saved.resourceId,
        checks: { officialPackVerified: true, realNativeCompletion: true, encryptedStoreOpened: true,
          draftSaved: true, assistantPendingSaved: true, storeClosedBeforeReceipt: true },
        limitation: "Preparation phase only; restart and offline proof require the second receipt." });
    }

    active();
    beginStage("store-recovery", "Restauration des données chiffrées après redémarrage.");
    const storeA = await smarana.openSmaranaStore(OWNER_A);
    const recovered = await storeA.read(checkpoint.resourceId);
    const restored = recovered?.payload;
    requireCheck(recovered && restored && restored.draft === `${fixtureMarker}\nBrouillon exact : éàç, مرحبا, 👋`, "draft-not-restored");
    requireCheck(restored.messages.find(message => message.id === checkpoint.pendingId)?.state === "interrupted", "pending-not-recovered");
    requireCheck(restored.messages.find(message => message.id === checkpoint.pendingId)?.content === `${fixtureMarker}:réponse-partielle`, "partial-answer-not-restored");
    const previousAnswer = restored.messages.find(message => message.role === "assistant" && message.state === "complete");
    requireCheck(previousAnswer && await crypto.digestStringAsync(crypto.CryptoDigestAlgorithm.SHA256, previousAnswer.content) === checkpoint.firstAnswerHash,
      "first-native-answer-not-restored");
    requireCheck(recovered.syncState === "pending", "pending-sync-status-lost");
    active();
    beginStage("pack-inspection", "Vérification locale du pack après redémarrage.");
    requireCheck((await engine.inspect(controller.signal)).status === "ready", "pack-not-ready-after-restart");
    beginStage("native-completion", "Génération réelle hors connexion.");
    const answer = await engine.complete([{ role: "user", content: userPrompt }], { signal: controller.signal });
    checkNative(answer);
    active();
    beginStage("offline-storage", "Enregistrement durable de la réponse hors connexion.");
    const offlineAnswerId = crypto.randomUUID();
    const now = new Date().toISOString();
    const updated = await storeA.update(recovered.resourceId, recovered.localVersion, { ...restored,
      messages: [...restored.messages,
        { id: crypto.randomUUID(), role: "user", content: userPrompt, state: "complete", createdAt: now },
        { id: offlineAnswerId, role: "assistant", content: answer.text, state: "complete", createdAt: now }],
    });
    requireCheck(updated.syncState === "pending", "offline-answer-not-queued");

    // The adapter fences A before opening B; QA fixtures do not grant access to
    // any authenticated user's account and never invoke a remote service.
    beginStage("account-isolation", "Vérification de l’isolation des comptes synthétiques.");
    const storeB = await smarana.openSmaranaStore(OWNER_B);
    let previousOwnerFenced = false;
    try { await storeA.read(checkpoint.resourceId); }
    catch (error) { previousOwnerFenced = (error as { code?: unknown }).code === "closed"; }
    requireCheck(previousOwnerFenced && await storeB.read(checkpoint.resourceId) === null, "account-isolation-failed");
    requireCheck((await storeB.list()).length === 0, "fixture-b-not-empty");
    const recordB = await storeB.create({ title: "Fixture B", draft: "B uniquement", messages: [] });
    const reopenedA = await smarana.openSmaranaStore(OWNER_A);
    requireCheck(await reopenedA.read(recordB.resourceId) === null, "account-b-leaked-into-a");
    const persisted = await reopenedA.read(checkpoint.resourceId);
    requireCheck(persisted?.payload?.messages.find(message => message.id === offlineAnswerId)?.content === answer.text &&
      persisted.payload.draft === restored.draft, "offline-answer-not-durable");
    await smarana.closeSmaranaStore();
    active();

    beginStage("encryption-inspection", "Vérification des fichiers chiffrés.");
    const encryption = await inspectEncryptedFixture(OWNER_A, fixtureMarker, controller.signal);
    beginStage("key-verification", "Vérification du refus d’une mauvaise clé.");
    const wrongKey = await verifyWrongKeyRejected(OWNER_A);
    requireCheck(wrongKey.rejected, "wrong-key-not-rejected");
    const afterWrongKey = await smarana.openSmaranaStore(OWNER_A);
    requireCheck((await afterWrongKey.read(checkpoint.resourceId))?.payload?.draft === restored.draft, "wrong-key-modified-data");
    await smarana.closeSmaranaStore();
    beginStage("cleanup", "Libération du moteur après les contrôles natifs.");
    await engine.release();
    active();
    requireCheck(unexpectedNetworkCalls === 0, "unexpected-js-network");
    checkpointFile.write(JSON.stringify({ schema: 1, phase: "complete", runId }));
    onStatus?.("Qualification native hors connexion réussie sur cet émulateur.");
    return emit({ schema: 1, phase: "complete", status: "PASS", ...common,
      elapsedMs: Math.round(performance.now() - startedAt),
      backend: answer.native.backend, gpu: answer.native.gpu,
      nativeOutput: answer.text.slice(0, 256), tokensGenerated: answer.tokensGenerated,
      checks: { draftRestoredAfterProcessRestart: true, firstNativeAnswerRestored: true,
        pendingAssistantRecoveredAsInterrupted: true, partialAnswerPreserved: true,
        packReverifiedAfterRestart: true, realOfflineNativeCompletion: true,
        offlineAnswerDurable: true, syncRemainsPending: true, accountIsolation: true,
        previousOwnerFenced: true, wrongKeyRejected: true, correctKeyStillReads: true,
        noPlaintextFixtureInDatabaseFiles: true, globalFetchXHRWebSocketBlocked: true,
        unexpectedJsNetworkCalls: 0 },
      encryption: { ...encryption, cipherVersion: wrongKey.cipherVersion },
      limitations: ["Synthetic account fixtures, not production authentication or cloud synchronization.",
        "ADB must independently disable airplane/Wi-Fi/mobile connectivity before this phase.",
        "Global JavaScript networking is guarded; no packet capture proves every native SDK's total network activity.",
        "A successful smoke and answer establish execution, not universal answer quality or every device's compatibility."] });
  } catch (error) {
    controller.abort();
    const candidate = (error as { code?: unknown } | null)?.code;
    const code = typeof candidate === "string" && /^[a-z0-9_-]{1,80}$/.test(candidate) ? candidate : "native-qualification-failed";
    onStatus?.(`Qualification interrompue : ${code}`);
    const state = engine?.getState();
    return emit({ schema: 1, phase: "failed", status: "FAIL", attemptedPhase: phase, runId, code,
      stage, elapsedMs: Math.round(performance.now() - startedAt), stageElapsedMs: Math.round(performance.now() - stageStartedAt),
      ...(state ? { pack: { status: state.status, phase: state.phase,
        progressPercent: Math.max(0, Math.min(100, Math.floor(state.progress * 100))) } } : {}), fixtureAccountsOnly: true });
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribePack?.();
    await closeStore?.().catch(() => {});
    await engine?.release().catch(() => {});
    restoreNetwork?.();
  }
}

async function inspectEncryptedFixture(ownerId: string, marker: string, signal: AbortSignal) {
  const { File, Paths } = await import("expo-file-system");
  const names = [`account-${ownerId}.db`, `account-${ownerId}.db-wal`, `account-${ownerId}.db-shm`, `account-${ownerId}.db-journal`];
  const needle = Uint8Array.from(marker, letter => letter.charCodeAt(0));
  const header = Uint8Array.from(SQL_HEADER, letter => letter.charCodeAt(0));
  const files: { name: string; bytes: number }[] = [];
  for (const name of names) {
    requireCheck(!signal.aborted, "qualification-timeout");
    const file = new File(Paths.document, "smarana", name);
    if (!file.exists) { requireCheck(name !== names[0], "database-file-missing"); continue; }
    requireCheck(file.size >= 0 && file.size <= 64 * 1024 ** 2, "unexpected-fixture-size");
    if (name === names[0]) requireCheck(file.size >= 4096, "database-file-empty");
    const handle = file.open();
    let read = 0;
    let carry: Uint8Array = new Uint8Array(0);
    try {
      while (read < file.size) {
        requireCheck(!signal.aborted, "qualification-timeout");
        const block = handle.readBytes(Math.min(64 * 1024, file.size - read));
        requireCheck(block.length > 0, "database-read-failed");
        if (read === 0 && name === names[0]) requireCheck(!header.every((byte, index) => block[index] === byte), "database-is-plaintext-sqlite");
        const joined = new Uint8Array(carry.length + block.length);
        joined.set(carry); joined.set(block, carry.length);
        for (let offset = 0; offset <= joined.length - needle.length; offset += 1) {
          if (needle.every((byte, index) => joined[offset + index] === byte)) throw new QualificationError("plaintext-fixture-found");
        }
        carry = joined.slice(Math.max(0, joined.length - needle.length + 1));
        read += block.length;
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    } finally { handle.close(); }
    files.push({ name, bytes: read });
  }
  return { mainHeaderOpaque: true, plaintextMarkerAbsent: true, files };
}

async function verifyWrongKeyRejected(ownerId: string): Promise<{ rejected: boolean; cipherVersion: string }> {
  const [sqlite, fs] = await Promise.all([import("expo-sqlite"), import("expo-file-system/legacy")]);
  requireCheck(fs.documentDirectory, "document-directory-unavailable");
  const db = await sqlite.openDatabaseAsync(`account-${ownerId}.db`, { useNewConnection: true }, `${fs.documentDirectory}smarana`);
  try {
    const cipher = await db.getFirstAsync<{ cipher_version: string }>("PRAGMA cipher_version");
    requireCheck(cipher && /^\d+\.\d+/.test(cipher.cipher_version), "sqlcipher-unavailable");
    // Fixed known-wrong test key. No real device key is read, changed or logged.
    await db.execAsync(`PRAGMA key = "x'${"00".repeat(32)}'"`);
    let rejected = false;
    try { await db.getFirstAsync("SELECT count(*) FROM sqlite_master"); }
    catch { rejected = true; }
    return { rejected, cipherVersion: cipher.cipher_version };
  } finally { await db.closeAsync(); }
}
