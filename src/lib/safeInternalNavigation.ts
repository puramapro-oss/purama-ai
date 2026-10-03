const INTERNAL_BASE = 'https://purama.invalid';
const MAX_URL_LENGTH = 2_048;
const MAX_DECODE_PASSES = 5;

function hasUnsafeShape(value: string): boolean {
  const hasControl = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  return !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || hasControl;
}

/**
 * Returns a normalized same-origin route, or null for anything that could be
 * interpreted as an absolute/protocol-relative URL. Encoded delimiters are
 * checked repeatedly so double encoding cannot bypass the boundary.
 */
export function safeInternalPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return null;
  if (value !== value.trim() || hasUnsafeShape(value)) return null;

  let decoded = value;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) break;
    if (hasUnsafeShape(next)) return null;
    decoded = next;
    if (pass === MAX_DECODE_PASSES - 1) return null;
  }

  try {
    const parsed = new URL(value, INTERNAL_BASE);
    if (parsed.origin !== INTERNAL_BASE || parsed.username || parsed.password) return null;
    if (hasUnsafeShape(parsed.pathname)) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}
