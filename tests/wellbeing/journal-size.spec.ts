import { test, expect } from '@playwright/test';

const journalKey = 'purama_gratitude:v2:account-a';
const path = '/tests/wellbeing/index.html?view=journal';
const escapedText = '\u0000'.repeat(1999) + 'x';

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === 'http://127.0.0.1:4396') return route.continue();
    return route.abort('blockedbyclient');
  });
});

test('device retention refuses an encoded journal that its reader would reject', async ({ page }) => {
  await page.goto(path);
  const observed = await page.evaluate(async ({ key, text }) => {
    const modulePath = '/src/lib/gratitude-journal.ts';
    const journal = await import(/* @vite-ignore */ modulePath);
    // Every entry satisfies the existing 2,000-character and 500-entry limits.
    // JSON escaping expands these accepted characters beyond the read budget.
    const entries = Array.from({ length: 210 }, (_, index) => ({
      id: 'note-' + index, text, date: '2026-11-10', createdAt: '2026-11-10T10:00:00Z',
    }));
    const result = await journal.mutateGratitudeJournal(
      'account-a', { kind: 'enable', entries, expectedRaw: null }, new AbortController().signal,
    );
    const raw = localStorage.getItem(key);
    return {
      ok: result.ok,
      reason: result.ok ? null : result.reason,
      storedCharacters: raw?.length ?? 0,
      decodedCount: journal.decodeGratitudeJournal(raw, 'account-a')?.length ?? null,
    };
  }, { key: journalKey, text: escapedText });
  expect(observed).toEqual({ ok: false, reason: 'sizeLimit', storedCharacters: 0, decodedCount: null });
});

test('device retention accepts the exact serialized limit and reads every note back', async ({ page }) => {
  await page.goto(path);
  const observed = await page.evaluate(async ({ key, text }) => {
    const modulePath = '/src/lib/gratitude-journal.ts';
    const journal = await import(/* @vite-ignore */ modulePath);
    const entries = Array.from({ length: 206 }, (_, index) => ({
      id: 'note-' + index, text, date: '2026-11-10', createdAt: '2026-11-10T10:00:00Z',
    }));
    const boundaryEntry = { id: 'boundary-note', text: 'x', date: '2026-11-10', createdAt: '2026-11-10T10:00:00Z' };
    entries.push(boundaryEntry);
    const encodedTextBudget = 2_500_000 - journal.encodeGratitudeJournal(entries, 'account-a').length + 1;
    const escapedCharacters = Math.floor((encodedTextBudget - 1) / 6);
    boundaryEntry.text = '\u0000'.repeat(escapedCharacters) + 'x'.repeat(encodedTextBudget - escapedCharacters * 6);
    const result = await journal.mutateGratitudeJournal(
      'account-a', { kind: 'enable', entries, expectedRaw: null }, new AbortController().signal,
    );
    const raw = localStorage.getItem(key);
    const restored = journal.decodeGratitudeJournal(raw, 'account-a');
    return {
      ok: result.ok,
      storedCharacters: raw?.length,
      exactReadback: JSON.stringify(restored) === JSON.stringify(entries),
      count: restored?.length,
      longestNote: Math.max(...entries.map(entry => entry.text.length)),
    };
  }, { key: journalKey, text: escapedText });
  expect(observed).toEqual({
    ok: true, storedCharacters: 2_500_000, exactReadback: true, count: 207, longestNote: 2000,
  });
});

for (const language of ['fr', 'en'] as const) {
  test('an oversized append keeps the readable journal and draft, with a size message in ' + language, async ({ page }) => {
    await page.goto(path);
    const initial = await page.evaluate(async ({ key, text }) => {
      const modulePath = '/src/lib/gratitude-journal.ts';
      const journal = await import(/* @vite-ignore */ modulePath);
      const entries = Array.from({ length: 206 }, (_, index) => ({
        id: 'note-' + index, text, date: '2026-11-10', createdAt: '2026-11-10T10:00:00Z',
      }));
      const raw = journal.encodeGratitudeJournal(entries, 'account-a');
      localStorage.setItem(key, raw);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
      return {
        characters: raw.length, count: journal.decodeGratitudeJournal(raw, 'account-a')?.length,
        checksum: Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join(''),
      };
    }, { key: journalKey, text: escapedText });
    expect(initial.count).toBe(206);
    await page.reload();
    if (language === 'en') await page.getByRole('button', { name: 'English', exact: true }).click();
    await expect(page.getByRole('checkbox')).toBeChecked();
    const labels = language === 'fr'
      ? { add: 'Ajouter une note', save: 'Enregistrer la note', alert: /taille/i, saved: 'Note enregistrée.' }
      : { add: 'Add a note', save: 'Save note', alert: /size/i, saved: 'Note saved.' };
    await page.getByRole('button', { name: labels.add, exact: true }).click();
    const draft = page.getByRole('textbox');
    await draft.fill(escapedText);
    expect(await draft.evaluate((element, text) => (element as HTMLTextAreaElement).value === text, escapedText)).toBe(true);
    await page.getByRole('button', { name: labels.save, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(labels.alert);
    expect(await draft.evaluate((element, text) => (element as HTMLTextAreaElement).value === text, escapedText)).toBe(true);
    await expect(page.getByText(labels.saved, { exact: true })).toHaveCount(0);
    const retained = await page.evaluate(async key => {
      const modulePath = '/src/lib/gratitude-journal.ts';
      const journal = await import(/* @vite-ignore */ modulePath);
      const raw = localStorage.getItem(key);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw ?? ''));
      return {
        characters: raw?.length, count: journal.decodeGratitudeJournal(raw, 'account-a')?.length,
        checksum: Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join(''),
      };
    }, journalKey);
    expect(retained).toEqual(initial);
    await page.reload();
    await expect(page.getByRole('checkbox')).toBeChecked();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}
