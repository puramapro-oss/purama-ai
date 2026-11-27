import { safeInternalPath } from '../../../src/lib/safeNavigation.ts';

/** One navigation boundary for new notifications and historical client rows.
 * Keep internal absolute paths and explicit HTTPS links. Never turn a protocol-
 * relative path, a credential-bearing URL or a script scheme into navigation.
 */
export function resolveNotificationActionUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048
    || /[\s\\<>"'`]/u.test(value)
    || [...value].some(character => { const code = character.codePointAt(0)!; return code < 32 || (code >= 127 && code <= 159); })) return null;
  if (value.startsWith('/')) {
    const internal = safeInternalPath(value);
    return internal !== null && internal.length <= 2048 ? internal : null;
  }
  if (!/^https:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password
      || url.href.length > 2048) return null;
    const resolved = url.href;
    return resolved;
  } catch { return null; }
}
