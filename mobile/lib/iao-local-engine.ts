import type { CompletionParams, JinjaFormattedChatResult, LlamaContext, TokenData } from "llama.rn";
import { IAO_LOCAL_PACK_MANIFEST } from "./iao-local-manifest";
import { assertIaoLocalActive, createIaoLocalPack, IaoLocalError } from "./iao-local-pack";
import type { IaoLocalPack, IaoLocalPackReady, IaoLocalPackState, IaoLocalProgress, IaoLocalSmokeTest } from "./iao-local-pack";

export { IaoLocalError } from "./iao-local-pack";
export { IAO_LOCAL_PACK_MANIFEST } from "./iao-local-manifest";
export type { IaoLocalPackReady, IaoLocalPackState, IaoLocalProgress } from "./iao-local-pack";

export type IaoLocalMessage = Readonly<{ role: "system" | "user" | "assistant"; content: string }>;
export type IaoLocalCompletion = Readonly<{
  text: string;
  modelVersion: string;
  finishReason: "stop" | "length";
  contextTruncated: boolean;
  omittedMessages: number;
  tokensGenerated: number;
  native: Readonly<{ backend: "llama.rn"; gpu: false; modelSha256: string }>;
}>;
export type IaoLocalCompletionOptions = Readonly<{
  signal?: AbortSignal;
  /** Full visible assistant text so far, not a raw token or hidden reasoning. */
  onToken?: (text: string) => void;
}>;

type NativeContext = Pick<LlamaContext,
  "completion" | "stopCompletion" | "release" | "isJinjaSupported" | "getFormattedChat" | "tokenize" | "gpu">;
export type IaoLocalNativeModule = Readonly<{
  initLlama: (parameters: Parameters<typeof import("llama.rn").initLlama>[0]) => Promise<NativeContext>;
  setContextLimit: (limit: number) => Promise<void>;
  toggleNativeLog: (enabled: boolean) => Promise<void>;
}>;
export type IaoLocalEngineDependencies = Readonly<{
  /** Test seam only; the application singleton always uses the pinned native pack. */
  packFactory?: (smokeTest: IaoLocalSmokeTest) => IaoLocalPack;
  loadNative?: () => Promise<IaoLocalNativeModule>;
  hardware?: () => Promise<Readonly<{ supported: boolean; totalMemory: number | null }>>;
}>;

export interface IaoLocalEngine {
  getState(): IaoLocalPackState;
  subscribe(listener: IaoLocalProgress): () => void;
  inspect(signal?: AbortSignal): Promise<IaoLocalPackState>;
  prepare(signal?: AbortSignal, onProgress?: IaoLocalProgress): Promise<IaoLocalPackReady>;
  complete(messages: readonly IaoLocalMessage[], options?: IaoLocalCompletionOptions): Promise<IaoLocalCompletion>;
  cancel(): void;
  release(): Promise<void>;
}

const MAX_MESSAGES = 128;
const MAX_MESSAGE_CHARS = 32_000;
const MAX_INPUT_CHARS = 256_000;
const MAX_OUTPUT_CHARS = 65_536;
const CONTEXT_RESERVE = 32;
export const IAO_LOCAL_ENGINE_BUDGETS = Object.freeze({
  // A cold process must rehash the pinned 639 MB pack and run its native smoke
  // before admitting a prompt. That work has its own finite local-only budget.
  verificationMs: 10 * 60_000,
  inferenceMs: 180_000,
  preparationMs: 30 * 60_000,
});

// A module-wide lease covers all controller instances, including preparation
// smoke tests. The lease is retained until the actual native cleanup settles,
// even when the caller has already received a cancellation.
let processLease: symbol | undefined;
let processRequiresRestart = false;
let singleton: IaoLocalEngine | undefined;

export function getIaoLocalEngine(): IaoLocalEngine {
  singleton ??= createIaoLocalEngine();
  return singleton;
}

/** Construction is passive: native imports, filesystem and networking are deferred. */
export function createIaoLocalEngine(dependencies: IaoLocalEngineDependencies = {}): IaoLocalEngine {
  let nativePromise: Promise<IaoLocalNativeModule> | undefined;
  let active: { controller: AbortController; settled: Promise<void> } | undefined;

  async function native(): Promise<IaoLocalNativeModule> {
    if (!nativePromise) nativePromise = (async () => {
      let module: IaoLocalNativeModule;
      try {
        module = await (dependencies.loadNative ?? (() => import("llama.rn")))();
        await module.setContextLimit(1);
        await module.toggleNativeLog(false);
      } catch { throw new IaoLocalError("unsupported"); }
      return module;
    })().catch(error => { nativePromise = undefined; throw error; });
    return nativePromise;
  }

  async function qualifyHardware(signal?: AbortSignal): Promise<void> {
    assertIaoLocalActive(signal);
    let hardware: { supported: boolean; totalMemory: number | null };
    try {
      hardware = await (dependencies.hardware ?? (async () => {
        const [{ Platform }, device] = await Promise.all([import("react-native"), import("expo-device")]);
        return { supported: Platform.OS === "android" || Platform.OS === "ios", totalMemory: device.totalMemory };
      }))();
    } catch { throw new IaoLocalError("unsupported"); }
    assertIaoLocalActive(signal);
    if (!hardware.supported) throw new IaoLocalError("unsupported");
    if (hardware.totalMemory === null || !Number.isFinite(hardware.totalMemory) ||
        hardware.totalMemory < IAO_LOCAL_PACK_MANIFEST.minimumMemoryBytes) throw new IaoLocalError("memory");
  }

  async function withContext<T>(modelUri: string, signal: AbortSignal | undefined,
    work: (context: NativeContext) => Promise<T>): Promise<T> {
    assertIaoLocalActive(signal);
    if (!modelUri.startsWith("file://")) throw new IaoLocalError("integrity");
    const module = await native();
    assertIaoLocalActive(signal);
    let context: NativeContext | undefined;
    let stopPending: Promise<void> | undefined;
    let result: T | undefined;
    let failure: IaoLocalError | undefined;
    const stop = () => {
      if (!context || stopPending) return;
      // v0.12.9 can reject a stop that races an already settled completion.
      // This rejection is contained; release is still mandatory below.
      stopPending = Promise.resolve().then(() => context!.stopCompletion()).catch(() => undefined);
    };
    try {
      context = await module.initLlama({
        model: modelUri,
        is_model_asset: false,
        n_ctx: IAO_LOCAL_PACK_MANIFEST.contextTokens,
        n_parallel: 1,
        n_batch: 128,
        n_ubatch: 128,
        n_threads: 2,
        n_gpu_layers: 0,
        devices: ["CPU"],
        use_mmap: true,
        use_mlock: false,
        no_extra_bufts: true,
        flash_attn_type: "off",
        ctx_shift: false,
      });
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      assertIaoLocalActive(signal);
      if (context.gpu !== false) throw new IaoLocalError("native");
      if (!context.isJinjaSupported()) throw new IaoLocalError("native");
      result = await work(context);
      assertIaoLocalActive(signal);
    } catch (error) {
      failure = signal?.aborted ? new IaoLocalError("aborted")
        : error instanceof IaoLocalError ? error : new IaoLocalError("native");
    } finally {
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) stop();
      await stopPending;
      if (context) {
        try { await context.release(); }
        catch {
          // An uncertain native release cannot allow a second context or a new
          // user's prompt to reuse a possibly live native allocation.
          processRequiresRestart = true;
          failure = new IaoLocalError("restart-required");
        }
      }
    }
    if (failure) throw failure;
    return result as T;
  }

  async function formattedPrompt(context: NativeContext, input: readonly IaoLocalMessage[],
    outputTokens: number, signal?: AbortSignal): Promise<{ formatted: JinjaFormattedChatResult; omitted: number }> {
    const messages = input.map(message => ({ ...message }));
    let omitted = 0;
    while (true) {
      assertIaoLocalActive(signal);
      const formatted = await context.getFormattedChat(messages, undefined, {
        jinja: true, enable_thinking: false, reasoning_format: "auto",
        chat_template_kwargs: { enable_thinking: false }, add_generation_prompt: true,
      });
      assertIaoLocalActive(signal);
      if (!formatted.prompt || formatted.prompt.length > MAX_INPUT_CHARS + MAX_MESSAGE_CHARS ||
          formatted.has_media) throw new IaoLocalError("invalid-message");
      const tokenized = await context.tokenize(formatted.prompt);
      assertIaoLocalActive(signal);
      if (tokenized.has_media) throw new IaoLocalError("invalid-message");
      if (tokenized.tokens.length + outputTokens + CONTEXT_RESERVE <= IAO_LOCAL_PACK_MANIFEST.contextTokens) {
        return { formatted: formatted as JinjaFormattedChatResult, omitted };
      }
      // Preserve the system instruction and current user message. Older turns
      // remain in durable history; only this bounded inference window changes.
      const first = messages[0]?.role === "system" ? 1 : 0;
      if (first >= messages.length - 1) throw new IaoLocalError("context-limit");
      messages.splice(first, 1);
      omitted += 1;
      while (first < messages.length - 1 && messages[first].role === "assistant") {
        messages.splice(first, 1);
        omitted += 1;
      }
    }
  }

  async function generate(context: NativeContext, input: readonly IaoLocalMessage[], outputTokens: number,
    signal?: AbortSignal, onToken?: (text: string) => void) {
    const { formatted, omitted } = await formattedPrompt(context, input, outputTokens, signal);
    assertIaoLocalActive(signal);
    let invalidStream = false;
    let acceptingTokens = true;
    let visible = "";
    const onNativeToken = (data: TokenData) => {
      if (!acceptingTokens || signal?.aborted || invalidStream || typeof data.content !== "string" || !data.content || data.content === visible) return;
      if (data.content.length > MAX_OUTPUT_CHARS) {
        invalidStream = true;
        void Promise.resolve().then(() => context.stopCompletion()).catch(() => undefined);
        return;
      }
      visible = data.content;
      try { onToken?.(visible); } catch { /* A UI observer is not a native lifetime owner. */ }
    };
    const parameters: CompletionParams = {
      // Supplying the already formatted prompt avoids a second asynchronous
      // formatting step inside completion(), where an early stop could be lost.
      prompt: formatted.prompt,
      chat_format: formatted.chat_format,
      generation_prompt: formatted.generation_prompt,
      chat_parser: formatted.chat_parser,
      grammar: formatted.grammar,
      grammar_lazy: formatted.grammar_lazy,
      grammar_triggers: formatted.grammar_triggers,
      preserved_tokens: formatted.preserved_tokens,
      stop: formatted.additional_stops ?? [],
      thinking_forced_open: false,
      enable_thinking: false,
      reasoning_format: "auto",
      n_predict: outputTokens,
      temperature: 0.7,
      top_p: 0.8,
      top_k: 20,
      min_p: 0,
    };
    let result: Awaited<ReturnType<NativeContext["completion"]>>;
    try { result = await context.completion(parameters, onNativeToken); }
    finally { acceptingTokens = false; }
    assertIaoLocalActive(signal);
    if (result.interrupted) throw new IaoLocalError("aborted");
    if (result.truncated) throw new IaoLocalError("context-limit");
    if (invalidStream || typeof result.content !== "string" || !result.content.trim() || result.content.length > MAX_OUTPUT_CHARS ||
        !Number.isSafeInteger(result.tokens_predicted) || result.tokens_predicted < 1) throw new IaoLocalError("invalid-output");
    // The native parsed content excludes reasoning/tool payloads. Never fall
    // back to result.text or raw token strings for a user-visible answer.
    return { text: result.content, finishReason: result.stopped_limit || result.context_full ? "length" as const : "stop" as const,
      contextTruncated: omitted > 0, omittedMessages: omitted, tokensGenerated: result.tokens_predicted };
  }

  const smokeTest: IaoLocalSmokeTest = async (uri, signal) => {
    await withContext(uri, signal, context => generate(context,
      [{ role: "user", content: "Réponds simplement : Bonjour." }], 16, signal));
  };
  const pack = dependencies.packFactory?.(smokeTest) ?? createIaoLocalPack({ smokeTest });

  function runExclusive<T>(work: (signal: AbortSignal, beginInference: () => void) => Promise<T>, external: AbortSignal | undefined,
    budgetMs: number): Promise<T> {
    if (external?.aborted) return Promise.reject(new IaoLocalError("aborted"));
    if (processRequiresRestart) return Promise.reject(new IaoLocalError("restart-required"));
    if (processLease) return Promise.reject(new IaoLocalError("busy"));
    const lease = Symbol("purama-local-operation");
    processLease = lease;
    const controller = new AbortController();
    let timedOut = false;
    const forward = () => controller.abort();
    external?.addEventListener("abort", forward, { once: true });
    if (external?.aborted) controller.abort();
    const expire = () => { timedOut = true; controller.abort(); };
    let deadline = performance.now() + budgetMs;
    let timer = setTimeout(expire, budgetMs);
    const assertDeadline = () => {
      // A busy JS thread can deliver timers late. Settling a native/file task
      // must not erase an already elapsed deadline before its callback runs.
      if (!controller.signal.aborted && performance.now() >= deadline) expire();
      assertIaoLocalActive(controller.signal);
    };
    let inferenceStarted = false;
    const beginInference = () => {
      // Only one transition is allowed. A late verification must never revive
      // a cancelled/expired operation or repeatedly extend its deadline.
      assertDeadline();
      if (inferenceStarted) throw new IaoLocalError("native");
      inferenceStarted = true;
      clearTimeout(timer);
      deadline = performance.now() + IAO_LOCAL_ENGINE_BUDGETS.inferenceMs;
      timer = setTimeout(expire, IAO_LOCAL_ENGINE_BUDGETS.inferenceMs);
    };
    let rejectCancellation: (error: IaoLocalError) => void = () => {};
    const cancelled = new Promise<never>((_, reject) => { rejectCancellation = reject; });
    const onAbort = () => rejectCancellation(new IaoLocalError(timedOut ? "timeout" : "aborted"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    const record = { controller, settled: Promise.resolve() };
    active = record;
    const job = (async () => {
      try {
        assertDeadline();
        const result = await work(controller.signal, beginInference);
        assertDeadline();
        return result;
      } catch (error) {
        if (timedOut) throw new IaoLocalError("timeout");
        if (controller.signal.aborted) throw new IaoLocalError("aborted");
        throw error instanceof IaoLocalError ? error : new IaoLocalError("native");
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
        external?.removeEventListener("abort", forward);
        if (processLease === lease) processLease = undefined;
        if (active === record) active = undefined;
      }
    })();
    record.settled = job.then(() => undefined, () => undefined);
    // Cancellation is visible promptly. job continues solely to settle native
    // stop/release, and keeps the process lease until that cleanup completes.
    return Promise.race([job, cancelled]);
  }

  return {
    getState: () => pack.getState(),
    subscribe: listener => pack.subscribe(listener),
    inspect(signal) {
      return runExclusive(async current => {
        // Inspecting an absent pack does not initialize llama or download it.
        await qualifyHardware(current);
        return pack.inspect(current);
      }, signal, IAO_LOCAL_ENGINE_BUDGETS.verificationMs);
    },
    prepare(signal, observer) {
      return runExclusive(async current => {
        await qualifyHardware(current);
        await native(); // Reject Expo Go/missing native runtime before a large download.
        assertIaoLocalActive(current);
        return pack.prepare(current, observer);
      }, signal, IAO_LOCAL_ENGINE_BUDGETS.preparationMs);
    },
    complete(messages, options = {}) {
      let bounded: IaoLocalMessage[];
      try { bounded = validateMessages(messages); }
      catch (error) { return Promise.reject(error); }
      return runExclusive(async (current, beginInference) => {
        await qualifyHardware(current);
        const prepared = await pack.requireReady(current); // Local verification only, never prepare().
        beginInference();
        const response = await withContext(prepared.modelUri, current, context => generate(context, bounded,
          IAO_LOCAL_PACK_MANIFEST.maximumOutputTokens, current, options.onToken));
        return { ...response, modelVersion: prepared.modelVersion,
          native: { backend: "llama.rn", gpu: false, modelSha256: IAO_LOCAL_PACK_MANIFEST.model.sha256 } };
      }, options.signal, IAO_LOCAL_ENGINE_BUDGETS.verificationMs);
    },
    cancel() { active?.controller.abort(); },
    async release() {
      const operation = active;
      operation?.controller.abort();
      await operation?.settled;
    },
  };
}

function validateMessages(input: readonly IaoLocalMessage[]): IaoLocalMessage[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_MESSAGES) throw new IaoLocalError("invalid-message");
  let total = 0;
  const result = input.map((message, index) => {
    if (!message || !["system", "user", "assistant"].includes(message.role) ||
        (message.role === "system" && index !== 0) || typeof message.content !== "string" ||
        !message.content.trim() || message.content.length > MAX_MESSAGE_CHARS) throw new IaoLocalError("invalid-message");
    total += message.content.length;
    if (total > MAX_INPUT_CHARS) throw new IaoLocalError("invalid-message");
    return { role: message.role, content: message.content };
  });
  if (result[result.length - 1].role !== "user") throw new IaoLocalError("invalid-message");
  return result;
}
