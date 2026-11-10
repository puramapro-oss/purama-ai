import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Heart, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { useAwakening } from '@/hooks/useAwakening';
import { wellbeingCopy } from '@/lib/wellbeing-copy';
import { decodeGratitudeJournal, gratitudeStorageKey, localJournalDate, mutateGratitudeJournal, MAX_JOURNAL_ENTRIES, MAX_JOURNAL_TEXT, type GratitudeEntry, type JournalSnapshot, type JournalMutation, type JournalMutationError } from '@/lib/gratitude-journal';

type JournalError = Exclude<JournalMutationError, 'cancelled'> | null;
type Notice = 'saved' | 'deleted' | 'forgotten' | null;

function getEntries(ownerId: string | null): JournalSnapshot & { error: JournalError } {
  if (!ownerId) return { entries: [], remember: false, raw: null, error: null };
  try {
    const raw = localStorage.getItem(gratitudeStorageKey(ownerId));
    if (!raw) return { entries: [], remember: false, raw: null, error: null };
    const entries = decodeGratitudeJournal(raw, ownerId);
    return entries ? { entries, remember: true, raw, error: null } : { entries: [], remember: false, raw, error: 'invalid' };
  } catch {
    return { entries: [], remember: false, raw: null, error: 'storageError' };
  }
}

function GratitudeJournal({ ownerId }: { ownerId: string | null }) {
  const { i18n } = useTranslation();
  const copy = wellbeingCopy(i18n.language);
  const { recordGratitude } = useAwakening();
  const [initial] = useState(() => getEntries(ownerId));
  const [snapshot, setSnapshot] = useState<JournalSnapshot>(initial);
  const snapshotRef = useRef<JournalSnapshot>(initial);
  const { entries, remember } = snapshot;
  const [error, setError] = useState<JournalError>(initial.error);
  const [notice, setNotice] = useState<Notice>(null);
  const [newText, setNewText] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const lifetime = useRef(new AbortController());
  const textId = useId();

  const replaceSnapshot = useCallback((next: JournalSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!ownerId) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== gratitudeStorageKey(ownerId)) return;
      // Read the latest value, not an older event payload queued behind a newer
      // write. Draft text is never erased by another tab's storage event.
      const next = getEntries(ownerId);
      const current = snapshotRef.current;
      setNotice(null);
      if (next.error) { setError(next.error); return; }
      if (!current.remember && !next.remember) {
        // Clearing browser storage is not a request to erase a different tab's
        // in-memory notes. Only an active retained snapshot can be revoked.
        replaceSnapshot({ ...current, raw: next.raw });
        setError(null); return;
      }
      if (next.remember && !current.remember && current.entries.length > 0) {
        setError('conflict'); return; // Preserve unpersisted session notes.
      }
      replaceSnapshot(next);
      setError(current.remember && !next.remember ? 'revoked' : null);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [ownerId, replaceSnapshot]);

  const persist = async (mutation: JournalMutation): Promise<boolean> => {
    if (!ownerId || pending.current) return false;
    const signal = lifetime.current.signal;
    pending.current = true; setBusy(true); setNotice(null);
    try {
      const result = await mutateGratitudeJournal(ownerId, mutation, signal);
      if (signal.aborted) return false;
      if (result.ok === false) {
        if (result.reason === 'cancelled') return false;
        if (result.reason === 'revoked') replaceSnapshot({ entries: [], remember: false, raw: null });
        setError(result.reason); return false;
      }
      replaceSnapshot(result.snapshot); setError(null); return true;
    } finally {
      pending.current = false;
      if (!signal.aborted) setBusy(false);
    }
  };

  const toggleRemember = async (checked: boolean) => {
    if (!ownerId || initial.error === 'invalid') return;
    const current = snapshotRef.current;
    const changed = await persist(checked ? { kind: 'enable', entries: current.entries, expectedRaw: current.raw } : { kind: 'disable' });
    if (changed && !checked) setNotice('forgotten');
  };

  const handleAdd = async () => {
    if (pending.current) return;
    const text = newText.trim();
    if (!text || text.length > MAX_JOURNAL_TEXT) return;
    const current = snapshotRef.current;
    const entry: GratitudeEntry = { id: crypto.randomUUID(), text, date: localJournalDate(), createdAt: new Date().toISOString() };
    if (current.remember) {
      if (!await persist({ kind: 'append', entry })) return;
    } else {
      if (current.entries.length >= MAX_JOURNAL_ENTRIES) { setError('limit'); return; }
      replaceSnapshot({ ...current, entries: [entry, ...current.entries] });
    }
    setNewText(''); setIsAdding(false); setNotice('saved'); recordGratitude();
  };

  const handleDelete = async (id: string) => {
    if (pending.current) return;
    const current = snapshotRef.current;
    if (current.remember) {
      if (!await persist({ kind: 'remove', id })) return;
    } else replaceSnapshot({ ...current, entries: current.entries.filter(entry => entry.id !== id) });
    setNotice('deleted');
  };

  const grouped = useMemo(() => {
    const groups = new Map<string, GratitudeEntry[]>();
    for (const entry of entries) groups.set(entry.date, [...(groups.get(entry.date) ?? []), entry]);
    return [...groups].sort(([left], [right]) => right.localeCompare(left));
  }, [entries]);

  const formatDate = (date: string) => date === localJournalDate() ? copy.journal.today
    : new Date(`${date}T12:00:00`).toLocaleDateString(copy.locale, { day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div lang={copy.locale} dir="ltr" aria-busy={busy} className="max-w-2xl space-y-6">
      <div>
        <h1 className="flex items-center gap-3 text-2xl font-bold"><Heart aria-hidden="true" className="h-7 w-7" />{copy.journal.title}</h1>
        <p className="mt-2 text-muted-foreground">{copy.journal.description}</p>
      </div>
      <Card><CardContent className="space-y-3 pt-6">
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-1 h-4 w-4" checked={remember} disabled={busy || !ownerId || initial.error === 'invalid'} onChange={event => { void toggleRemember(event.target.checked); }} />
          <span>{copy.journal.remember}</span>
        </label>
        <p className="text-sm text-muted-foreground">{remember ? copy.journal.device : copy.journal.session}</p>
        {!ownerId && <p className="text-sm">{copy.journal.disabled}</p>}
        {!remember && <p className="text-xs text-muted-foreground">{copy.journal.device}</p>}
      </CardContent></Card>
      {error && <p role="alert" className="rounded border border-destructive p-3">{copy.journal[error]}</p>}
      {notice && <p role="status">{copy.journal[notice]}</p>}
      {busy && <p role="status">{copy.journal.working}</p>}
      {!isAdding ? <Button type="button" disabled={busy} onClick={() => { setIsAdding(true); setNotice(null); }}>{copy.journal.add}</Button>
        : <form onSubmit={event => { event.preventDefault(); void handleAdd(); }} className="space-y-3">
          <label htmlFor={textId} className="block font-medium">{copy.journal.label}</label>
          <textarea id={textId} disabled={busy} maxLength={MAX_JOURNAL_TEXT} value={newText} onChange={event => setNewText(event.target.value)} placeholder={copy.journal.placeholder} aria-describedby={`${textId}-limit`} className="min-h-24 w-full rounded-xl border border-border bg-background p-3" autoFocus />
          <p id={`${textId}-limit`} className="text-sm text-muted-foreground">{copy.journal.maxLength}</p>
          <div className="flex gap-3"><Button type="submit" disabled={busy || !newText.trim()}>{copy.journal.save}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => { setIsAdding(false); setNewText(''); }}>{copy.journal.cancel}</Button></div>
        </form>}
      {grouped.length === 0 ? <div className="rounded-xl border border-border p-6"><p>{copy.journal.empty}</p><p className="mt-2 text-sm text-muted-foreground">{copy.journal.invitation}</p></div>
        : grouped.map(([date, notes]) => <section key={date} aria-label={formatDate(date)} className="space-y-3">
          <h2 className="font-medium">{formatDate(date)}</h2>
          <ul className="space-y-3">{notes.map(entry => <li key={entry.id} className="flex items-start justify-between gap-3 rounded-xl border border-border p-4">
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{entry.text}</p>
            <Button type="button" variant="outline" size="icon" aria-label={copy.journal.remove} disabled={busy} onClick={() => { void handleDelete(entry.id); }}><Trash2 aria-hidden="true" className="h-4 w-4" /></Button>
          </li>)}</ul>
        </section>)}
    </div>
  );
}

export default function Gratitude() {
  const { user, loading } = useAuth();
  return loading ? null : <GratitudeJournal key={user?.id ?? 'anonymous'} ownerId={user?.id ?? null} />;
}
