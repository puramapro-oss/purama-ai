import {
  JEV_MODEL,
  validateJevRequest,
  validateJevResponse,
  type JevRequest,
  type JevResponse,
} from './schema.js';

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MAX_RESPONSE_BYTES = 524_288;

export type JevTransportErrorCode =
  | 'authentication'
  | 'credits'
  | 'rate_limit'
  | 'provider_unavailable'
  | 'invalid_request'
  | 'invalid_response'
  | 'cancelled';

const ERROR_CODES: readonly JevTransportErrorCode[] = [
  'authentication', 'credits', 'rate_limit', 'provider_unavailable',
  'invalid_request', 'invalid_response', 'cancelled',
];

/** No provider body, credentials, or upstream error message is exposed. */
export class JevTransportError extends Error {
  readonly code: JevTransportErrorCode;
  readonly attempted: boolean;

  constructor(code: JevTransportErrorCode, attempted: boolean) {
    super(`JEV_TRANSPORT_${code.toUpperCase()}`);
    this.name = 'JevTransportError';
    this.code = code;
    this.attempted = attempted;
  }
}

export interface JevClientOptions {
  apiKey: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}

function assertActive(signal: AbortSignal, attempted: boolean): void {
  if (signal.aborted) throw new JevTransportError('cancelled', attempted);
}

function httpError(status: number): JevTransportErrorCode {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 402) return 'credits';
  if (status === 429) return 'rate_limit';
  if (status >= 400 && status < 500) return 'invalid_request';
  return 'provider_unavailable';
}

/**
 * One bounded, version-pinned request. The caller owns authorization, accounting,
 * the global deadline, and any retry policy; this transport performs no retries.
 */
export async function requestJev(
  request: JevRequest,
  options: JevClientOptions,
): Promise<JevResponse> {
  let attempted = false;
  let signal: AbortSignal | undefined;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let succeeded = false;
  let cancellationRequested = false;
  let abortListener: (() => void) | undefined;

  // Cancellation is best effort and must not add a second, unbounded wait to
  // the caller's deadline. Attach a rejection handler without logging details.
  const cancelBody = (): void => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    try {
      const pending = reader ? reader.cancel() : response?.body?.cancel();
      if (pending) void pending.catch(() => undefined);
    } catch {
      // The original sanitized transport error remains authoritative.
    }
  };

  try {
    if (options === null || typeof options !== 'object') {
      throw new JevTransportError('invalid_request', false);
    }
    const apiKey = options.apiKey;
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0
      || /[\u0000-\u001f\u007f-\u009f]/.test(apiKey)) {
      throw new JevTransportError('invalid_request', false);
    }
    const suppliedSignal = options.signal;
    if (!(suppliedSignal instanceof AbortSignal)) {
      throw new JevTransportError('invalid_request', false);
    }
    signal = suppliedSignal;
    assertActive(signal, false);

    const normalized = validateJevRequest(request);
    const fetchImpl = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl;
    if (typeof fetchImpl !== 'function') {
      throw new JevTransportError('invalid_request', false);
    }
    // Constructing Headers before dispatch also rejects invalid header values.
    const headers = new Headers({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    });
    const body = JSON.stringify({ model: JEV_MODEL, ...normalized });
    assertActive(signal, false);

    attempted = true;
    try {
      response = await fetchImpl(JEV_ENDPOINT, {
        method: 'POST',
        headers,
        body,
        signal,
        redirect: 'error',
      });
    } catch {
      assertActive(signal, true);
      throw new JevTransportError('provider_unavailable', true);
    }
    assertActive(signal, true);
    if (!(response instanceof Response)) {
      throw new JevTransportError('invalid_response', true);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new JevTransportError(httpError(response.status), true);
    }
    if (!response.body) throw new JevTransportError('invalid_response', true);

    reader = response.body.getReader();
    abortListener = cancelBody;
    signal.addEventListener('abort', abortListener, { once: true });
    assertActive(signal, true);

    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    while (true) {
      assertActive(signal, true);
      const chunk = await reader.read();
      assertActive(signal, true);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        throw new JevTransportError('invalid_response', true);
      }
      bytes += chunk.value.byteLength;
      if (bytes > JEV_MAX_RESPONSE_BYTES) {
        throw new JevTransportError('invalid_response', true);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const parsed: unknown = JSON.parse(text);
    const result = validateJevResponse(parsed, normalized);
    assertActive(signal, true);
    succeeded = true;
    return result;
  } catch (error) {
    if (signal?.aborted) throw new JevTransportError('cancelled', attempted);
    if (error instanceof JevTransportError && ERROR_CODES.includes(error.code)) {
      // Reconstruct rather than forwarding even an upstream instance's message.
      throw new JevTransportError(error.code, attempted);
    }
    throw new JevTransportError(attempted ? 'invalid_response' : 'invalid_request', attempted);
  } finally {
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    if (!succeeded) cancelBody();
    if (reader) {
      try {
        reader.releaseLock();
      } catch {
        // Cleanup must never expose an upstream error or replace a safe result.
      }
    }
  }
}
