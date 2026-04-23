// DocuSeal API client — works in browser (Vite) and Deno (Edge Functions)
// https://docuseal.purama.dev

import type { DocusealSubmission, DocusealTemplate, DocusealSubmitter } from './types';

export interface DocusealClientConfig {
  apiUrl: string;
  apiToken: string;
  timeoutMs?: number;
}

export class DocusealError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'DocusealError';
    this.status = status;
    this.body = body;
  }
}

export class DocusealClient {
  private apiUrl: string;
  private apiToken: string;
  private timeoutMs: number;

  constructor(config: DocusealClientConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.apiToken = config.apiToken;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers: {
          'X-Auth-Token': this.apiToken,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        let errBody: unknown;
        try { errBody = await res.json(); } catch { errBody = await res.text(); }
        throw new DocusealError(
          `DocuSeal ${method} ${path} → HTTP ${res.status}`,
          res.status,
          errBody,
        );
      }
      // 204 No Content
      if (res.status === 204) return {} as T;
      return await res.json() as T;
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DocusealError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new DocusealError(`DocuSeal timeout after ${this.timeoutMs}ms`, 0, null);
      }
      throw new DocusealError(`DocuSeal network error: ${(err as Error).message}`, 0, null);
    }
  }

  // ─── Templates ──────────────────────────────────────────────────────
  async listTemplates(params: { limit?: number; after?: number } = {}): Promise<{
    data: DocusealTemplate[];
    pagination: { count: number; next: number | null; prev: number | null };
  }> {
    const q = new URLSearchParams();
    if (params.limit) q.set('limit', String(params.limit));
    if (params.after) q.set('after', String(params.after));
    return this.request('GET', `/api/templates${q.toString() ? `?${q}` : ''}`);
  }

  async getTemplate(id: number): Promise<DocusealTemplate> {
    return this.request('GET', `/api/templates/${id}`);
  }

  async createTemplateFromHtml(input: {
    html: string;
    name: string;
    folder_name?: string;
    external_id?: string;
  }): Promise<DocusealTemplate> {
    return this.request('POST', '/api/templates/html', input);
  }

  async updateTemplate(id: number, input: { name?: string; folder_name?: string }): Promise<DocusealTemplate> {
    return this.request('PUT', `/api/templates/${id}`, input);
  }

  async deleteTemplate(id: number): Promise<void> {
    return this.request('DELETE', `/api/templates/${id}`);
  }

  // ─── Submissions ────────────────────────────────────────────────────
  async createSubmission(input: {
    template_id: number;
    send_email?: boolean;
    send_sms?: boolean;
    redirect_url?: string;
    completed_redirect_url?: string;
    submitters: Array<{
      email: string;
      name?: string;
      phone?: string;
      role?: string;
      values?: Record<string, string | number | boolean>;
    }>;
    message?: { subject?: string; body?: string };
  }): Promise<DocusealSubmission[]> {
    return this.request('POST', '/api/submissions', input);
  }

  async getSubmission(id: number): Promise<DocusealSubmission> {
    return this.request('GET', `/api/submissions/${id}`);
  }

  async listSubmissions(params: {
    limit?: number;
    after?: number;
    template_id?: number;
    status?: string;
  } = {}): Promise<{
    data: DocusealSubmission[];
    pagination: { count: number; next: number | null; prev: number | null };
  }> {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v !== undefined && q.set(k, String(v)));
    return this.request('GET', `/api/submissions${q.toString() ? `?${q}` : ''}`);
  }

  async archiveSubmission(id: number): Promise<void> {
    return this.request('DELETE', `/api/submissions/${id}`);
  }

  // ─── Submitters (individual signers) ────────────────────────────────
  async getSubmitter(id: number): Promise<DocusealSubmitter> {
    return this.request('GET', `/api/submitters/${id}`);
  }

  async updateSubmitter(id: number, input: {
    email?: string;
    name?: string;
    values?: Record<string, unknown>;
    send_email?: boolean;
    completed?: boolean;
  }): Promise<DocusealSubmitter> {
    return this.request('PUT', `/api/submitters/${id}`, input);
  }

  // Returns a signed URL the signer can click to resume signing
  submitterSigningUrl(submitterSlug: string): string {
    return `${this.apiUrl}/s/${submitterSlug}`;
  }
}

/** Factory that reads env vars. Works in Vite (browser) and Deno (Edge). */
export function createDocusealClient(override?: Partial<DocusealClientConfig>): DocusealClient {
  let apiUrl = override?.apiUrl;
  let apiToken = override?.apiToken;

  // Browser (Vite)
  if (!apiUrl && typeof import.meta !== 'undefined' && (import.meta as { env?: Record<string, string> }).env) {
    apiUrl = (import.meta as { env?: Record<string, string> }).env?.VITE_DOCUSEAL_API_URL;
    apiToken = apiToken ?? (import.meta as { env?: Record<string, string> }).env?.VITE_DOCUSEAL_API_TOKEN;
  }

  // Deno (Edge Functions)
  const denoEnv = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env;
  if (!apiUrl && denoEnv) {
    apiUrl = denoEnv.get('DOCUSEAL_API_URL');
    apiToken = apiToken ?? denoEnv.get('DOCUSEAL_API_TOKEN');
  }

  // Node (fallback)
  const procEnv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
  if (!apiUrl && procEnv) {
    apiUrl = procEnv.DOCUSEAL_API_URL;
    apiToken = apiToken ?? procEnv.DOCUSEAL_API_TOKEN;
  }

  if (!apiUrl || !apiToken) {
    throw new Error('DOCUSEAL_API_URL and DOCUSEAL_API_TOKEN must be configured');
  }

  return new DocusealClient({ apiUrl, apiToken, timeoutMs: override?.timeoutMs });
}
