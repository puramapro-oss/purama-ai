/** A narrow, complete UTF-8 plain-text view. Unsupported parts require review;
 * no body fragment, HTML, attached file or external attachment is guessed. */
type Row = Record<string, unknown>;
const object = (value: unknown): Row | null => value !== null && typeof value === 'object'
  && !Array.isArray(value) ? value as Row : null;
export function hasReplyControls(value: string, allowWhitespace = false): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 127 || code < 32 && (!allowWhitespace || ![9, 10, 13].includes(code))) return true;
  }
  return false;
}
export function replyHeader(payload: unknown, name: string, required = false): string {
  const headers = object(payload)?.headers;
  if (!Array.isArray(headers) || headers.length > 200) throw new Error('reply_content_unverified');
  const matches = headers.filter(value => typeof object(value)?.name === 'string'
    && String(object(value)?.name).toLowerCase() === name.toLowerCase());
  if (matches.length > 1 || required && matches.length !== 1) throw new Error('reply_content_unverified');
  if (!matches.length) return '';
  const value = object(matches[0])?.value;
  if (typeof value !== 'string' || value.length > 8192 || hasReplyControls(value)) throw new Error('reply_content_unverified');
  return value.trim();
}
export function replyAddress(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 998 || hasReplyControls(value)) return null;
  const exact = /^[^\s@<>,;:]+@[^\s@<>,;:]+\.[^\s@<>,;:]+$/;
  const trimmed = value.trim();
  if (exact.test(trimmed)) return trimmed.toLowerCase();
  const wrapped = trimmed.match(/^(?:"[^"]*"|[^<>"@,;]+)?\s*<([^<>]+)>$/);
  return wrapped && exact.test(wrapped[1]) ? wrapped[1].toLowerCase() : null;
}
export function completeReplyText(payload: unknown): string {
  let visited = 0;
  const walk = (value: unknown, depth: number): string => {
    const part = object(value);
    if (!part || ++visited > 100 || depth > 8 || typeof part.mimeType !== 'string'
      || part.filename !== undefined && part.filename !== ''
      || replyHeader(part, 'content-disposition')) throw new Error('reply_content_unverified');
    if (part.mimeType.toLowerCase() === 'multipart/alternative') {
      if (!Array.isArray(part.parts) || part.parts.length > 20) throw new Error('reply_content_unverified');
      // Exactly one text/plain representation. Other alternatives may only be
      // inline HTML; mixed parts, attachments and multiple texts stay blocked.
      const plain = part.parts.filter(child => object(child)?.mimeType === 'text/plain');
      if (plain.length !== 1 || part.parts.some(child => {
        const entry = object(child);
        return !entry || !['text/plain', 'text/html'].includes(String(entry.mimeType))
          || entry.filename !== undefined && entry.filename !== '' || replyHeader(entry, 'content-disposition');
      })) throw new Error('reply_content_unverified');
      return walk(plain[0], depth + 1);
    }
    if (part.mimeType.toLowerCase() !== 'text/plain' || part.parts !== undefined) throw new Error('reply_content_unverified');
    const charset = /(?:^|;)\s*charset\s*=\s*"?([^;"\s]+)/i.exec(replyHeader(part, 'content-type'))?.[1]?.toLowerCase() ?? 'utf-8';
    if (!['utf-8', 'utf8', 'us-ascii', 'ascii'].includes(charset)) throw new Error('reply_content_unverified');
    const body = object(part.body);
    const data = body?.data;
    if (!body || body.attachmentId !== undefined || typeof data !== 'string'
      || data.length > 87384 || !/^[A-Za-z0-9_-]*={0,2}$/.test(data)
      || data.length % 4 === 1 || data.includes('=') && data.length % 4 !== 0) throw new Error('reply_content_unverified');
    const unpadded = data.replace(/=+$/, '');
    const normalized = unpadded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    if (btoa(binary).replace(/=+$/, '') !== normalized || binary.length > 65536
      || body.size !== undefined && body.size !== binary.length) throw new Error('reply_content_unverified');
    const bytes = Uint8Array.from(binary, value => value.charCodeAt(0));
    if (['ascii', 'us-ascii'].includes(charset) && bytes.some(value => value > 127)) throw new Error('reply_content_unverified');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.trim() || hasReplyControls(text, true)) throw new Error('reply_content_unverified');
    return text;
  };
  return walk(payload, 0);
}
