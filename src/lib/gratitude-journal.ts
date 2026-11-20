export interface GratitudeEntry {
  id: string;
  text: string;
  date: string;
  createdAt: string;
}

export const MAX_JOURNAL_ENTRIES = 500;
export const MAX_JOURNAL_TEXT = 2000;
export const MAX_JOURNAL_SERIALIZED_LENGTH = 2_500_000;

export function gratitudeStorageKey(ownerId: string): string {
  return `purama_gratitude:v2:${encodeURIComponent(ownerId)}`;
}

export function localJournalDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function isEntry(value: unknown): value is GratitudeEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(entry.id)) return false;
  if (typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > MAX_JOURNAL_TEXT) return false;
  if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) return false;
  const parsedDate = new Date(`${entry.date}T12:00:00Z`);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== entry.date) return false;
  return typeof entry.createdAt === 'string' && entry.createdAt.length <= 40 && Number.isFinite(Date.parse(entry.createdAt));
}

// Only a versioned, explicitly retained journal belonging to the active account
// may be restored. The old unscoped key is deliberately never read or migrated.
export function decodeGratitudeJournal(raw: string | null, ownerId: string): GratitudeEntry[] | null {
  if (!raw || raw.length > MAX_JOURNAL_SERIALIZED_LENGTH) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || value.version !== 2 || value.ownerId !== ownerId || value.retention !== 'device') return null;
    if (!Array.isArray(value.entries) || value.entries.length > MAX_JOURNAL_ENTRIES || !value.entries.every(isEntry)) return null;
    const ids = value.entries.map((entry: GratitudeEntry) => entry.id);
    if (new Set(ids).size !== ids.length) return null;
    return value.entries;
  } catch {
    return null;
  }
}

export function encodeGratitudeJournal(entries: GratitudeEntry[], ownerId: string): string {
  return JSON.stringify({ version: 2, ownerId, retention: 'device', entries });
}

export interface JournalSnapshot {
  entries: GratitudeEntry[];
  remember: boolean;
  raw: string | null;
}

export type JournalMutation =
  | { kind: 'append'; entry: GratitudeEntry }
  | { kind: 'remove'; id: string }
  | { kind: 'enable'; entries: GratitudeEntry[]; expectedRaw: string | null }
  | { kind: 'disable' };

export type JournalMutationError = 'storageError' | 'invalid' | 'limit' | 'sizeLimit' | 'conflict' | 'revoked' | 'locksUnavailable' | 'busy' | 'cancelled';
export type JournalMutationResult = { ok: true; snapshot: JournalSnapshot } | { ok: false; reason: JournalMutationError };

/**
 * All cooperating tabs use this same exclusive lock. Append/remove operate on
 * the current stored document, never on the caller's stale list. Enabling a
 * session-only journal uses an exact snapshot check under that lock: a conflict
 * is reported without replacing another tab's data or discarding local notes.
 * Without Web Locks, durable writes fail closed; session-only use still works.
 */
export async function mutateGratitudeJournal(ownerId: string, mutation: JournalMutation, signal: AbortSignal): Promise<JournalMutationResult> {
  if (signal.aborted) return { ok: false, reason: 'cancelled' };
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return { ok: false, reason: 'locksUnavailable' };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 5000);
  try {
    return await navigator.locks.request(gratitudeStorageKey(ownerId), { mode: 'exclusive', signal: controller.signal }, (): JournalMutationResult => {
      if (signal.aborted) return { ok: false, reason: 'cancelled' };
      const key = gratitudeStorageKey(ownerId);
      const raw = localStorage.getItem(key);
      const stored = decodeGratitudeJournal(raw, ownerId);
      if (mutation.kind === 'disable') {
        if (raw !== null && stored === null) return { ok: false, reason: 'invalid' };
        localStorage.removeItem(key);
        return { ok: true, snapshot: { entries: stored ?? [], remember: false, raw: null } };
      }
      let entries: GratitudeEntry[];
      if (mutation.kind === 'enable') {
        if (raw !== mutation.expectedRaw) return { ok: false, reason: 'conflict' };
        if (raw !== null && stored === null) return { ok: false, reason: 'invalid' };
        if (!mutation.entries.every(isEntry)) return { ok: false, reason: 'invalid' };
        entries = mutation.entries;
      } else {
        // Revocation in any tab takes effect before another queued mutation.
        if (raw === null) return { ok: false, reason: 'revoked' };
        if (stored === null) return { ok: false, reason: 'invalid' };
        if (mutation.kind === 'append') {
          if (!isEntry(mutation.entry)) return { ok: false, reason: 'invalid' };
          entries = stored.some(entry => entry.id === mutation.entry.id) ? stored : [mutation.entry, ...stored];
        } else entries = stored.filter(entry => entry.id !== mutation.id);
      }
      if (entries.length > MAX_JOURNAL_ENTRIES) return { ok: false, reason: 'limit' };
      if (new Set(entries.map(entry => entry.id)).size !== entries.length) return { ok: false, reason: 'invalid' };
      const updatedRaw = encodeGratitudeJournal(entries, ownerId);
      if (updatedRaw.length > MAX_JOURNAL_SERIALIZED_LENGTH) return { ok: false, reason: 'sizeLimit' };
      localStorage.setItem(key, updatedRaw);
      return { ok: true, snapshot: { entries, remember: true, raw: updatedRaw } };
    });
  } catch (error) {
    if (signal.aborted) return { ok: false, reason: 'cancelled' };
    return { ok: false, reason: controller.signal.aborted ? 'busy' : 'storageError' };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
  }
}
