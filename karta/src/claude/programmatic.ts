import type Anthropic from "@anthropic-ai/sdk";
import type { AgentDecision, AnyToolDefinition } from "../engine/types.js";
import { validateProgrammaticToolParams } from "../engine/tool-input.js";
import type { ClaudeDecideInput } from "./types.js";
import type { ModelExecutionCapability } from "./execution-profile.js";
import { MAX_PROGRAMMATIC_RESPONSES, normalizeModelUsage, normalizeProgrammaticUsage } from "./usage.js";

/** The sandbox belongs to Anthropic. KARTA never evaluates provider code. */
export const PROGRAMMATIC_CODE_VERSION = "code_execution_20260120";
export const MAX_PROGRAMMATIC_CALLS = 16;
export const MAX_PROGRAMMATIC_RESULT_BYTES = 65_536;
export const MAX_PROGRAMMATIC_TOTAL_RESULT_BYTES = 262_144;
const MAX_HISTORY_BYTES = 2_097_152;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_CONTENT_BLOCKS = 128;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,200}$(?![\s\S])/;
type RecordValue = Record<string, unknown>;
type Bridge = NonNullable<ClaudeDecideInput["programmaticReads"]>;
type ProgrammaticCall = { id: string; tool: string; params: RecordValue };
type Message = { role: "user" | "assistant"; content: unknown };
type ServerName = "code_execution" | "bash_code_execution" | "text_editor_code_execution";

const invalid = (): never => { throw new Error("Réponse programmatique invalide ou incomplète : aucune décision disponible"); };
const record = (value: unknown): value is RecordValue => value !== null && typeof value === "object"
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const identifier = (value: unknown): value is string => typeof value === "string" && IDENTIFIER.test(value);
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const serializedBytes = (value: unknown): number => {
  const serialized = JSON.stringify(value);
  return typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : invalid();
};

export function parseProgrammaticReadsMode(value: unknown): boolean {
  if (value === undefined || value === "off") return false;
  if (value === "on") return true;
  throw new Error("KARTA_ANTHROPIC_PROGRAMMATIC_READS invalide : off ou on requis");
}

/** Opt in only after selecting the user's model. Partial catalogues and mixed
 * read/write agents keep their original strict direct route. */
export function useProgrammaticReads(options: {
  enabled: boolean; native: boolean; model: string;
  catalog: readonly ModelExecutionCapability[]; input: ClaudeDecideInput;
}): boolean {
  const { enabled, native, model, catalog, input } = options;
  const bridge = input.programmaticReads;
  if (!enabled || !native || !catalog.some(item => item.model === model
      && Object.hasOwn(item, "programmaticToolCalling") && item.programmaticToolCalling === true)
    || !bridge || typeof bridge.beforeRequest !== "function" || typeof bridge.execute !== "function"
    || !Array.isArray(bridge.toolNames) || !input.tools.length
    || input.tools.some(tool => !Object.hasOwn(tool, "programmaticRead") || tool.programmaticRead !== true
      || tool.sensitive !== false || tool.requiresExplicitApproval === true
      || ["code_execution", "bash_code_execution", "text_editor_code_execution"].includes(tool.name))) return false;
  const expected = new Set(input.tools.map(tool => tool.name));
  return bridge.toolNames.length === expected.size
    && new Set(bridge.toolNames).size === expected.size
    && Array.from(bridge.toolNames).every(name => typeof name === "string" && expected.has(name));
}

/** Unknown callers must not be flattened into ordinary direct tool calls. */
export function isDirectToolCaller(value: unknown): boolean {
  return value === undefined || (record(value) && value.type === "direct"
    && Object.keys(value).every(key => key === "type"));
}

function containerFrom(response: RecordValue, previous: string | undefined): string | undefined {
  const value = response.container;
  if (value === undefined || value === null) {
    if (previous !== undefined) return invalid();
    return undefined;
  }
  if (!record(value) || !identifier(value.id) || (previous !== undefined && value.id !== previous)
    || typeof value.expires_at !== "string" || !Number.isFinite(Date.parse(value.expires_at))
    || Date.parse(value.expires_at) <= Date.now()) return invalid();
  return value.id;
}

function validateServerCall(block: RecordValue): ServerName {
  if (!record(block.input)) return invalid();
  if (block.name === "code_execution") {
    if (typeof block.input.code !== "string" || !block.input.code.trim()) return invalid();
    return block.name;
  }
  if (block.name === "bash_code_execution") {
    if (typeof block.input.command !== "string" || !block.input.command.trim()) return invalid();
    return block.name;
  }
  if (block.name === "text_editor_code_execution") {
    if (!["view", "create", "str_replace"].includes(String(block.input.command))
      || typeof block.input.path !== "string" || !block.input.path) return invalid();
    return block.name;
  }
  return invalid();
}

/** Preserve raw blocks for continuation, but never treat error output, unknown
 * binary output, or an unqualified generated file as a successful read. */
function validateServerResult(block: RecordValue, expected: ServerName): void {
  const result = block.content;
  if (!record(result)) return invalid();
  if (expected === "code_execution" || expected === "bash_code_execution") {
    const type = expected === "code_execution" ? "code_execution_result" : "bash_code_execution_result";
    const blockType = expected === "code_execution" ? "code_execution_tool_result" : "bash_code_execution_tool_result";
    if (block.type !== blockType || result.type !== type || typeof result.stdout !== "string"
      || result.stderr !== "" || result.return_code !== 0 || !Array.isArray(result.content) || result.content.length !== 0) return invalid();
    return;
  }
  if (block.type !== "text_editor_code_execution_tool_result") return invalid();
  if (result.type === "text_editor_code_execution_view_result") {
    if (result.file_type !== "text" || typeof result.content !== "string"
      || ![result.num_lines, result.start_line, result.total_lines].every(nonnegative)) return invalid();
  } else if (result.type === "text_editor_code_execution_create_result") {
    if (typeof result.is_file_update !== "boolean") return invalid();
  } else if (result.type === "text_editor_code_execution_str_replace_result") {
    if (![result.old_start, result.old_lines, result.new_start, result.new_lines].every(nonnegative)
      || !Array.isArray(result.lines) || !result.lines.every(line => typeof line === "string")) return invalid();
  } else return invalid();
}

/** One bounded provider conversation, using the existing KARTA bridge for each
 * operation. The caller owns the total deadline. This function has no retry or
 * direct fallback: a sent request or executed read is never silently replayed. */
export async function runProgrammaticReads(options: {
  request: Anthropic.MessageCreateParamsNonStreaming;
  tools: readonly AnyToolDefinition[];
  bridge: Bridge;
  signal: AbortSignal;
  baseURL: string;
  onUsage: ClaudeDecideInput["onUsage"];
  send: (request: RecordValue) => Promise<unknown>;
}): Promise<AgentDecision> {
  const { tools, bridge, signal, baseURL, onUsage, send } = options;
  const request = structuredClone(options.request);
  const beforeRequest = bridge.beforeRequest;
  const execute = bridge.execute;
  const messages: Message[] = request.messages.map(message => ({ role: message.role, content: message.content }));
  const providerTools = [
    { type: PROGRAMMATIC_CODE_VERSION, name: "code_execution" },
    ...(request.tools ?? []).map(tool => {
      const definition = { ...tool } as unknown as RecordValue;
      delete definition.strict;
      return { ...definition, allowed_callers: ["direct", PROGRAMMATIC_CODE_VERSION] };
    }),
  ];
  const toolMap = new Map(tools.map(tool => [tool.name, {
    ...tool, ...(tool.inputSchema ? { inputSchema: structuredClone(tool.inputSchema) } : {}),
  }]));
  const responseIds = new Set<string>();
  const allCallIds = new Set<string>();
  const serverCalls = new Map<string, ServerName>();
  const completedServerCalls = new Set<string>();
  let container: string | undefined;
  let callCount = 0;
  let resultBytes = 0;
  for (let iteration = 0; iteration < MAX_PROGRAMMATIC_RESPONSES; iteration++) {
    signal.throwIfAborted();
    if (serializedBytes(messages) > MAX_HISTORY_BYTES) return invalid();
    await beforeRequest(signal);
    signal.throwIfAborted();
    const response = await send({ ...request, messages, tools: providerTools, ...(container ? { container } : {}) });
    // Retain receipts even when the response subsequently fails qualification.
    onUsage?.(normalizeModelUsage(response, request.model, baseURL), normalizeProgrammaticUsage(response));
    signal.throwIfAborted();
    if (!record(response) || response.type !== "message" || response.role !== "assistant"
      || !identifier(response.id) || responseIds.has(response.id) || response.model !== request.model
      || !["end_turn", "tool_use", "pause_turn"].includes(String(response.stop_reason))
      || !Array.isArray(response.content) || response.content.length > MAX_CONTENT_BLOCKS
      || serializedBytes(response.content) > MAX_RESPONSE_BYTES) return invalid();
    responseIds.add(response.id);
    container = containerFrom(response, container);
    const calls: ProgrammaticCall[] = [];
    const programmaticCallers: string[] = [];
    let summary = "";
    // Whole-response preflight. No callback can execute until every block is
    // checked, including a malformed later call or server execution failure.
    for (const block of response.content) {
      if (!record(block)) return invalid();
      if (block.type === "text") {
        if (typeof block.text !== "string") return invalid();
        summary += block.text;
      } else if (block.type === "thinking") {
        if (typeof block.thinking !== "string" || typeof block.signature !== "string") return invalid();
      } else if (block.type === "redacted_thinking") {
        if (typeof block.data !== "string") return invalid();
      } else if (block.type === "server_tool_use") {
        if (!identifier(block.id) || allCallIds.has(block.id) || !container) return invalid();
        allCallIds.add(block.id);
        serverCalls.set(block.id, validateServerCall(block));
      } else if (block.type === "tool_use") {
        if (response.stop_reason !== "tool_use" || !identifier(block.id) || allCallIds.has(block.id)
          || typeof block.name !== "string") return invalid();
        const tool = toolMap.get(block.name);
        if (!tool) return invalid();
        validateProgrammaticToolParams(tool, block.input);
        if (!record(block.input)) return invalid();
        if (!isDirectToolCaller(block.caller)) {
          if (!record(block.caller) || block.caller.type !== PROGRAMMATIC_CODE_VERSION
            || !identifier(block.caller.tool_id)
            || Object.keys(block.caller).some(key => key !== "type" && key !== "tool_id") || !container) return invalid();
          programmaticCallers.push(block.caller.tool_id);
        }
        allCallIds.add(block.id);
        calls.push({ id: block.id, tool: block.name, params: structuredClone(block.input) });
      } else if (["code_execution_tool_result", "bash_code_execution_tool_result", "text_editor_code_execution_tool_result"].includes(String(block.type))) {
        if (!identifier(block.tool_use_id) || completedServerCalls.has(block.tool_use_id)) return invalid();
        const name = serverCalls.get(block.tool_use_id);
        if (!name || !container) return invalid();
        validateServerResult(block, name);
        completedServerCalls.add(block.tool_use_id);
      } else return invalid();
    }
    if (programmaticCallers.some(id => serverCalls.get(id) !== "code_execution" || completedServerCalls.has(id))) return invalid();
    callCount += calls.length;
    if (callCount > MAX_PROGRAMMATIC_CALLS || (response.stop_reason === "tool_use" && calls.length === 0)) return invalid();
    if (response.stop_reason === "end_turn") {
      if (!summary.trim() || serverCalls.size !== completedServerCalls.size) return invalid();
      return { summary, toolCalls: [], requiresApproval: false, mock: false };
    }
    // Do not execute a final batch when no response budget remains to obtain
    // and validate its actual conclusion.
    if (iteration + 1 === MAX_PROGRAMMATIC_RESPONSES) return invalid();
    messages.push({ role: "assistant", content: structuredClone(response.content) });
    if (calls.length) {
      const results: RecordValue[] = [];
      for (const call of calls) {
        signal.throwIfAborted();
        const content = await execute(call, signal);
        signal.throwIfAborted();
        if (typeof content !== "string") return invalid();
        const bytes = Buffer.byteLength(content, "utf8");
        resultBytes += bytes;
        if (bytes > MAX_PROGRAMMATIC_RESULT_BYTES || resultBytes > MAX_PROGRAMMATIC_TOTAL_RESULT_BYTES) return invalid();
        results.push({ type: "tool_result", tool_use_id: call.id, content });
      }
      messages.push({ role: "user", content: results });
    }
  }
  return invalid();
}
