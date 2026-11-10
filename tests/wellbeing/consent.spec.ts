import { test, expect, type Page } from '@playwright/test';

const journalKey = 'purama_gratitude:v2:account-a';
const path = '/tests/wellbeing/index.html';

async function setRetention(page: Page, enabled: boolean) {
  const checkbox = page.getByRole('checkbox');
  if (await checkbox.isChecked() !== enabled) await checkbox.click();
  await expect(checkbox).toBeChecked({ checked: enabled });
}

async function addNote(page: Page, text: string) {
  await page.getByRole('button', { name: 'Ajouter une note', exact: true }).click();
  await page.getByRole('textbox', { name: 'Qu’aimerais-tu noter ?' }).fill(text);
  await page.getByRole('button', { name: 'Enregistrer la note', exact: true }).click();
}

async function escapeOnDialogMount(page: Page, alreadyPrevented = false, selector = '[role="dialog"]') {
  await page.evaluate(({ prevented, selector }) => {
    // Deliver the key in the mount microtask, while Radix's layer callback can
    // still retain its initial index. No sleep or changed application timer.
    const observer = new MutationObserver(() => {
      const dialog = document.querySelector(selector);
      const target = dialog?.querySelector('button');
      if (!target) return;
      observer.disconnect();
      target.focus();
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      if (prevented) event.preventDefault();
      target.dispatchEvent(event);
      (window as unknown as { immediateEscape: { delivered: boolean; prevented: boolean } }).immediateEscape = {
        delivered: true, prevented: event.defaultPrevented,
      };
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }, { prevented: alreadyPrevented, selector });
}

test('reopened pause handles Escape in the mount microtask without waiting for passive effects', async ({ page }) => {
  await page.clock.install();
  await page.goto(path);
  const trigger = page.getByRole('button', { name: 'Pause facultative' });
  await trigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await escapeOnDialogMount(page);
  await trigger.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { immediateEscape: unknown }).immediateEscape))
    .toEqual({ delivered: true, prevented: true });
});

test('pause leaves an already-prevented Escape to the control that consumed it', async ({ page }) => {
  await page.goto(path);
  await escapeOnDialogMount(page, true);
  await page.getByRole('button', { name: 'Pause facultative' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { immediateEscape: unknown }).immediateEscape))
    .toEqual({ delivered: true, prevented: true });
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('pause does not consume an immediate Escape belonging to a real nested Radix dialog', async ({ page }) => {
  await page.goto(path + '?nested-dialog');
  await page.getByRole('button', { name: 'Pause facultative' }).click();
  const outer = page.getByRole('dialog', { name: 'Un moment à ton rythme', exact: true });
  await expect(outer).toBeVisible();
  await escapeOnDialogMount(page, false, '[data-testid="nested-pause-dialog"]');
  await page.getByRole('button', { name: 'Ouvrir le dialogue imbriqué', exact: true }).click();
  const inner = page.getByRole('dialog', { name: 'Dialogue imbriqué de test', exact: true });
  await expect(inner).toBeVisible();
  await expect(outer).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { immediateEscape: unknown }).immediateEscape))
    .toEqual({ delivered: true, prevented: false });
  await page.getByRole('button', { name: 'Fermer le dialogue imbriqué', exact: true }).click();
  await expect(inner).toHaveCount(0);
  await expect(outer).toBeVisible();
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect(outer).toHaveCount(0);
});

test('a login never opens a practice; explicit choice, stop and Escape work', async ({ page }) => {
  await page.clock.install();
  await page.goto(path);
  await page.clock.runFor(5000);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const trigger = page.getByRole('button', { name: 'Pause facultative' });
  await trigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('Si cela correspond à tes convictions', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Une pause simple', exact: true }).click();
  await expect(page.getByText('Prends un instant pour remarquer', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Arrêter', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => /awakening|gratitude|affirmation/.test(key)))).toEqual([]);
});

test('spiritual content is explicitly selected, reversible and not saved', async ({ page }) => {
  await page.goto(path);
  await page.getByRole('button', { name: 'Pause facultative' }).click();
  await page.getByRole('button', { name: 'Un moment spirituel, si tu le souhaites' }).click();
  await expect(page.getByText('Si cela correspond à tes convictions', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'J’ai terminé cette pause' }).click();
  await page.getByRole('button', { name: 'Inconfortable', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Tu peux arrêter');
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.getByRole('button', { name: 'Pause facultative' }).click();
  await expect(page.getByRole('button', { name: 'Une pause simple' })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => /awakening|gratitude|affirmation/.test(key)))).toEqual([]);
});

test('account transition closes an open pause and guest use remains optional', async ({ page }) => {
  await page.goto(path);
  await page.getByRole('button', { name: 'Pause facultative' }).click();
  await page.getByRole('button', { name: 'Un geste de bienveillance' }).click();
  // The fixture changes the real AuthContext while the modal is open.
  await page.getByRole('button', { name: 'Account B', includeHidden: true }).evaluate(button => (button as HTMLButtonElement).click());
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Guest', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Pause facultative' }).click();
  await expect(page.getByRole('button', { name: 'Une pause simple' })).toBeVisible();
});

test('French and English copy work; other languages are clearly tagged as fallback', async ({ page }) => {
  await page.goto(path);
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.getByRole('button', { name: 'Optional pause' }).click();
  await expect(page.getByRole('dialog')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: 'A simple pause' })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Español', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Optional pause' })).toHaveAttribute('lang', 'en');
});

test('breathing timer genuinely pauses, resumes and stops without awarding completion', async ({ page }) => {
  await page.clock.install();
  await page.goto(path + '?view=breathe');
  await page.getByLabel('Durée indicative').selectOption('30');
  await page.getByRole('button', { name: 'Commencer', exact: true }).click();
  await page.clock.runFor(5000);
  await expect(page.getByTestId('breathing-countdown')).toHaveText('25');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.clock.runFor(20000);
  await expect(page.getByTestId('breathing-countdown')).toHaveText('25');
  await page.getByRole('button', { name: 'Reprendre', exact: true }).click();
  await page.clock.runFor(2000);
  await expect(page.getByTestId('breathing-countdown')).toHaveText('23');
  await page.getByRole('button', { name: 'Arrêter', exact: true }).click();
  await page.clock.runFor(60000);
  await expect(page.getByTestId('breathing-countdown')).toHaveText('23');
  await expect(page.getByRole('button', { name: 'J’ai terminé cette pause' })).toHaveCount(0);
  await expect(page.getByText(/XP|rétention 7|2 fois par jour/)).toHaveCount(0);
});

test('timer completion is distinguished from user-confirmed practice; hidden tab pauses', async ({ page }) => {
  await page.clock.install();
  await page.goto(path + '?view=breathe');
  await page.getByLabel('Durée indicative').selectOption('30');
  await page.getByRole('button', { name: 'Commencer', exact: true }).click();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.getByRole('button', { name: 'Reprendre', exact: true })).toBeVisible();
  await page.clock.runFor(30000);
  await expect(page.getByTestId('breathing-countdown')).toHaveText('30');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
  await page.getByRole('button', { name: 'Reprendre', exact: true }).click();
  await page.clock.runFor(30000);
  await expect(page.getByText('Cela ne mesure ni ta santé', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'J’ai terminé cette pause' }).click();
  await expect(page.getByRole('button', { name: 'Neutre', exact: true })).toBeVisible();
});

test('journal is session-only by default, without daily quotas or forced gratitude', async ({ page }) => {
  await page.goto(path + '?view=journal');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await addNote(page, 'A gentle conversation today.');
  await expect(page.getByText('A gentle conversation today.', { exact: true })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), journalKey)).toBeNull();
  await page.reload();
  await expect(page.getByText('A gentle conversation today.', { exact: true })).toHaveCount(0);
});

test('device retention is explicit, scoped by account, and revocable', async ({ page }) => {
  await page.goto(path + '?view=journal');
  await addNote(page, 'Private note A.');
  await setRetention(page, true);
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), journalKey);
  expect(stored.ownerId).toBe('account-a');
  expect(stored.retention).toBe('device');
  await page.reload();
  await expect(page.getByText('Private note A.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Account B', exact: true }).click();
  await expect(page.getByText('Private note A.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await addNote(page, 'Private note B.');
  await setRetention(page, true);
  await page.getByRole('button', { name: 'Account A', exact: true }).click();
  await expect(page.getByText('Private note A.', { exact: true })).toBeVisible();
  await expect(page.getByText('Private note B.', { exact: true })).toHaveCount(0);
  await setRetention(page, false);
  expect(await page.evaluate(key => localStorage.getItem(key), journalKey)).toBeNull();
  await page.reload();
  await expect(page.getByText('Private note A.', { exact: true })).toHaveCount(0);
});

test('a denied storage deletion is reported honestly and can be retried', async ({ page }) => {
  await page.goto(path + '?view=journal');
  await addNote(page, 'A note to remove.');
  await setRetention(page, true);
  await page.evaluate(() => {
    const original = Storage.prototype.removeItem;
    (window as unknown as { restoreStorage: () => void }).restoreStorage = () => { Storage.prototype.removeItem = original; };
    Storage.prototype.removeItem = function(key) { if (key.startsWith('purama_gratitude:v2:')) throw new DOMException('Denied', 'SecurityError'); original.call(this, key); };
  });
  await page.getByRole('checkbox').click();
  await expect(page.getByRole('checkbox')).toBeChecked();
  await expect(page.getByRole('alert')).toContainText('Aucune suppression');
  expect(await page.evaluate(key => localStorage.getItem(key), journalKey)).not.toBeNull();
  await page.evaluate(() => (window as unknown as { restoreStorage: () => void }).restoreStorage());
  await setRetention(page, false);
  expect(await page.evaluate(key => localStorage.getItem(key), journalKey)).toBeNull();
});

test('failed note persistence preserves the draft instead of reporting success', async ({ page }) => {
  await page.goto(path + '?view=journal');
  await setRetention(page, true);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key.startsWith('purama_gratitude:v2:')) throw new DOMException('Full', 'QuotaExceededError'); original.call(this, key, value); };
  });
  await addNote(page, 'Draft must remain.');
  await expect(page.getByRole('textbox')).toHaveValue('Draft must remain.');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('Note enregistrée.', { exact: true })).toHaveCount(0);
});

test('unowned legacy notes and wrong-owner retained data never cross accounts', async ({ page }) => {
  await page.addInitScript(key => {
    localStorage.setItem('purama_gratitude', JSON.stringify([{ id: 'legacy', text: 'Legacy secret.' }]));
    localStorage.setItem(key, JSON.stringify({ version: 2, ownerId: 'account-b', retention: 'device', entries: [{ id: 'wrong', text: 'Other account secret.', date: '2026-11-10', createdAt: '2026-11-10T10:00:00Z' }] }));
  }, journalKey);
  await page.goto(path + '?view=journal');
  await expect(page.getByText('Legacy secret.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Other account secret.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('pas été effacé');
  await expect(page.getByRole('checkbox')).toBeDisabled();
  expect(await page.evaluate(() => localStorage.getItem('purama_gratitude'))).toContain('Legacy secret.');
});

test('deleting a saved note works by keyboard; guest drafts cannot be retained', async ({ page }) => {
  await page.goto(path + '?view=journal');
  await addNote(page, 'A deletable note.');
  await setRetention(page, true);
  const remove = page.getByRole('button', { name: 'Supprimer cette note' });
  await remove.focus(); await page.keyboard.press('Enter');
  await expect(page.getByText('A deletable note.', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('A deletable note.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Guest', exact: true }).click();
  await expect(page.getByRole('checkbox')).toBeDisabled();
  await addNote(page, 'Guest note.');
  await expect(page.getByText('Guest note.', { exact: true })).toBeVisible();
});

test('activity API retains compatibility without spiritual rank, persistence or financial credit', async ({ page }) => {
  await page.goto(path + '?view=activity');
  await page.getByRole('button', { name: 'Legacy XP', exact: true }).click();
  await page.getByRole('button', { name: 'Record chosen pause', exact: true }).click();
  const data = JSON.parse(await page.getByTestId('activity').innerText());
  expect(data).toMatchObject({ xp: 0, streak: 0, progressToNext: 0, affirmationsSeen: 1 });
  await page.getByRole('button', { name: 'Account B', exact: true }).click();
  expect(JSON.parse(await page.getByTestId('activity').innerText()).affirmationsSeen).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('purama_awakening'))).toBeNull();
});

test('small viewport and reduced motion retain operable controls', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(path);
  await page.getByRole('button', { name: 'Pause facultative' }).click();
  await page.getByRole('button', { name: 'Un moment spirituel, si tu le souhaites' }).click();
  await expect(page.getByRole('button', { name: 'Arrêter', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('two tabs preserve independently added notes without stale overwrites', async ({ page, context }) => {
  await page.goto(path + '?view=journal');
  await addNote(page, 'Initial note A.');
  await setRetention(page, true);
  const other = await context.newPage();
  await other.goto(path + '?view=journal');
  await expect(other.getByText('Initial note A.', { exact: true })).toBeVisible();
  await addNote(page, 'Added from first tab B.');
  await addNote(other, 'Added from second tab C.');
  await page.reload();
  await expect(page.getByText('Initial note A.', { exact: true })).toBeVisible();
  await expect(page.getByText('Added from first tab B.', { exact: true })).toBeVisible();
  await expect(page.getByText('Added from second tab C.', { exact: true })).toBeVisible();
  await other.close();
});

test('a stale tab rebases its append and never resurrects a deleted note', async ({ page, context }) => {
  await page.goto(path + '?view=journal');
  await addNote(page, 'Initial note to delete.');
  await setRetention(page, true);
  const other = await context.newPage();
  // Deliberately delay the UI synchronization path: correctness must come from
  // the locked mutation of current storage, not just a timely storage event.
  await other.addInitScript(() => {
    window.addEventListener('storage', event => event.stopImmediatePropagation());
  });
  await other.goto(path + '?view=journal');
  await expect(other.getByText('Initial note to delete.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Supprimer cette note' }).click();
  await addNote(page, 'Current note from first tab.');
  await addNote(other, 'New note from stale tab.');
  await page.reload();
  await expect(page.getByText('Initial note to delete.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Current note from first tab.', { exact: true })).toBeVisible();
  await expect(page.getByText('New note from stale tab.', { exact: true })).toBeVisible();
  await other.close();
});

test('storage changes synchronize the other tab without clearing its draft', async ({ page, context }) => {
  await page.goto(path + '?view=journal');
  await addNote(page, 'Original shared note.');
  await setRetention(page, true);
  const other = await context.newPage();
  await other.goto(path + '?view=journal');
  await other.getByRole('button', { name: 'Ajouter une note', exact: true }).click();
  await other.getByRole('textbox').fill('Unsent draft stays here.');
  await addNote(page, 'Latest shared note.');
  await expect(other.getByText('Latest shared note.', { exact: true })).toBeVisible();
  await expect(other.getByRole('textbox')).toHaveValue('Unsent draft stays here.');
  await setRetention(page, false);
  await expect(other.getByRole('checkbox')).not.toBeChecked();
  await expect(other.getByRole('textbox')).toHaveValue('Unsent draft stays here.');
  await expect(other.getByText('Original shared note.', { exact: true })).toHaveCount(0);
  await other.getByRole('button', { name: 'Enregistrer la note', exact: true }).click();
  await expect(other.getByText('Unsent draft stays here.', { exact: true })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), journalKey)).toBeNull();
  await other.close();
});

test('a queued append cannot recreate retention revoked before its lock is granted', async ({ page, context }) => {
  await page.goto(path + '?view=journal');
  await addNote(page, 'A retained note.');
  await setRetention(page, true);
  const other = await context.newPage();
  await other.goto(path + '?view=journal');
  await page.evaluate(key => new Promise<void>(ready => {
    void navigator.locks.request(key, () => {
      ready();
      return new Promise<void>(release => { (window as unknown as { releaseJournalLock: () => void }).releaseJournalLock = release; });
    });
  }), journalKey);
  await page.getByRole('checkbox').click(); // revoke queued first
  await expect(page.getByText('Enregistrement en cours…', { exact: true })).toBeVisible();
  await addNote(other, 'Draft queued after revocation.');
  await expect(other.getByText('Enregistrement en cours…', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { releaseJournalLock: () => void }).releaseJournalLock());
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(other.getByRole('checkbox')).not.toBeChecked();
  await expect(other.getByRole('textbox')).toHaveValue('Draft queued after revocation.');
  await expect(other.getByRole('alert')).toContainText('conservation a été désactivée');
  expect(await page.evaluate(key => localStorage.getItem(key), journalKey)).toBeNull();
  await other.close();
});

test('conflicting retention activation preserves local notes and does not replace the other tab', async ({ page, context }) => {
  await page.goto(path + '?view=journal');
  await addNote(page, 'Session note in first tab.');
  const other = await context.newPage();
  await other.goto(path + '?view=journal');
  await addNote(other, 'Durable note from second tab.');
  await setRetention(other, true);
  await expect(page.getByRole('alert')).toContainText('Une autre fenêtre');
  await page.getByRole('checkbox').click();
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByText('Session note in first tab.', { exact: true })).toBeVisible();
  await other.reload();
  await expect(other.getByText('Durable note from second tab.', { exact: true })).toBeVisible();
  await expect(other.getByText('Session note in first tab.', { exact: true })).toHaveCount(0);
  await other.close();
});

test('without Web Locks durable storage fails closed while session notes remain usable', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
  await page.goto(path + '?view=journal');
  await addNote(page, 'Session note without locks.');
  await page.getByRole('checkbox').click();
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByRole('alert')).toContainText('pas disponible dans ce navigateur');
  await expect(page.getByText('Session note without locks.', { exact: true })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), journalKey)).toBeNull();
});

test('clearing storage in another tab preserves notes that were only in session', async ({ page, context }) => {
  await page.goto(path + '?view=journal');
  await addNote(page, 'Unsaved session note survives.');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await page.evaluate(() => {
    localStorage.setItem('wellbeing-clear-test', 'present');
    window.addEventListener('storage', event => {
      if (event.key === null) (window as unknown as { observedStorageClear: boolean }).observedStorageClear = true;
    });
  });
  const other = await context.newPage();
  await other.goto(path + '?view=journal');
  await other.evaluate(() => localStorage.clear());
  await expect.poll(() => page.evaluate(() => (window as unknown as { observedStorageClear?: boolean }).observedStorageClear)).toBe(true);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText('Unsaved session note survives.', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await other.close();
});
