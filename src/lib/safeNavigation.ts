const INTERNAL_ORIGIN = 'https://purama.invalid';
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
 * Accepts only same-origin path references. In particular, backslash variants are rejected
 * instead of relying on browser or router URL normalization.
 */
export function safeInternalPath(value: unknown): string | null;
export function safeInternalPath(value: unknown, fallback: string): string;
export function safeInternalPath(value: unknown, fallback?: string): string | null {
  const invalid = () => fallback ?? null;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return invalid();
  if (value !== value.trim() || hasUnsafeShape(value)) return invalid();

  let decoded = value;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return invalid();
    }
    if (next === decoded) break;
    if (hasUnsafeShape(next)) return invalid();
    decoded = next;
    if (pass === MAX_DECODE_PASSES - 1) return invalid();
  }

  try {
    const parsed = new URL(value, INTERNAL_ORIGIN);
    if (parsed.origin !== INTERNAL_ORIGIN || parsed.username || parsed.password) return invalid();
    if (hasUnsafeShape(parsed.pathname)) return invalid();
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return invalid();
  }
}
