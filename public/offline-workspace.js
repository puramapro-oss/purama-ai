/* PURAMA — local text workspace. No inference, cloud API or automatic synchronisation. */
import { MAX_BACKUP_BYTES, MAX_BACKUP_RECORDS, serializeBackup, parseBackup, prepareRestore, planRestore, coreEquals, truncateText } from './offline-library-backup.js';

(() => {
  'use strict';

  const DB_NAME = 'purama-offline-workspace';
  const DB_VERSION = 1;
  const STORE_NAME = 'texts';
  const CACHE_NAME = 'purama-offline-v8';
  const MAX_TEXT_BYTES = 1024 * 1024;
  const REQUIRED_ASSETS = ['/offline.html', '/offline-workspace.js', '/offline-library-backup.js', '/manifest.json'];
  const byId = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    'document-title', 'document-body', 'save-document', 'save-copy',
    'reload-document', 'delete-document', 'new-draft', 'import-file',
    'search-input', 'refresh-library', 'document-list', 'library-count',
    'save-status', 'storage-status', 'preparation-status', 'prepare-offline',
    'export-document', 'error-message', 'document-kind', 'character-count',
    'backup-library', 'restore-file', 'restore-preview', 'restore-summary',
    'confirm-restore', 'cancel-restore', 'backup-status',
    'speak-text', 'stop-speech', 'speech-status',
  ].map((id) => [id, byId(id)]));
  if (Object.values(ui).some((element) => !element)) return;

  const state = {
    db: null, current: null, snapshot: { title: '', body: '' },
    dirty: false, busy: false, conflict: null, records: [], pendingRestore: null,
    listRequest: 0, refreshPending: false, opening: null, preparing: false, preparationCheck: 0,
  };
  const encoder = new TextEncoder();
  let channel = null;
  const SPEECH_CHUNK_UNITS = 240;
  const SPEECH_TIMEOUT_MS = 45000;
  const speech = { synth: null, voice: null, run: null, generation: 0, utterance: null, timer: null, stopUnconfirmed: false };

  class ConflictError extends Error {
    constructor(deleted = false) {
      super(deleted
        ? 'Ce texte a été supprimé dans un autre onglet. Votre version reste dans cet éditeur. Exportez-la ou enregistrez une copie.'
        : 'Ce texte a changé dans un autre onglet. Votre version n’a pas remplacé la version enregistrée. Rechargez-la ou enregistrez une copie.');
      this.name = 'ConflictError';
      this.deleted = deleted;
    }
  }

  function status(id, value, message) {
    ui[id].dataset.state = value;
    ui[id].textContent = message;
  }

  function showError(message) {
    ui['error-message'].textContent = message;
    ui['error-message'].hidden = false;
  }

  function clearError() {
    ui['error-message'].textContent = '';
    ui['error-message'].hidden = true;
  }

  function describeStorageError(error) {
    if (error && error.name === 'QuotaExceededError') {
      return 'Enregistrement impossible : le stockage est plein ou son quota est atteint. Votre texte reste dans l’éditeur. Exportez-le avant de quitter, puis libérez de l’espace et réessayez.';
    }
    if (error && ['SecurityError', 'InvalidStateError', 'NotAllowedError'].includes(error.name)) {
      return 'Le stockage de ce navigateur est refusé ou indisponible. Vous pouvez continuer à écrire et exporter votre texte, mais il n’est pas enregistré ici.';
    }
    if (error && error.name === 'StorageBlockedError') return error.message;
    return 'L’enregistrement local n’a pas pu être confirmé. Votre texte reste dans l’éditeur : exportez-le avant de quitter ou réessayez.';
  }

  function updateControls() {
    const editable = !state.busy;
    ui['document-title'].disabled = !editable;
    ui['document-body'].disabled = !editable;
    ui['new-draft'].disabled = !editable;
    ui['import-file'].disabled = !editable;
    ui['save-document'].disabled = !editable || !state.db || Boolean(state.conflict);
    ui['save-copy'].hidden = !state.conflict;
    ui['save-copy'].disabled = !editable || !state.db;
    ui['reload-document'].hidden = !state.conflict;
    ui['reload-document'].disabled = !editable || !state.db;
    ui['delete-document'].disabled = !editable || !state.db || !state.current;
    ui['export-document'].disabled = !editable;
    ui['refresh-library'].disabled = !editable;
    ui['backup-library'].disabled = !editable || !state.db;
    ui['restore-file'].disabled = !editable;
    ui['confirm-restore'].disabled = !editable || !state.db || !state.pendingRestore;
    ui['cancel-restore'].disabled = !editable;
    ui['speak-text'].disabled = !editable || !speech.voice || Boolean(speech.run) || speech.stopUnconfirmed || !ui['document-body'].value.length;
    ui['stop-speech'].disabled = !speech.run && !speech.stopUnconfirmed;
    ui['stop-speech'].textContent = speech.stopUnconfirmed ? 'Réessayer l’arrêt' : 'Arrêter la lecture';
    for (const button of ui['document-list'].querySelectorAll('button')) button.disabled = !editable;
    ui['character-count'].textContent = `${ui['document-body'].value.length.toLocaleString('fr-FR')} caractères · texte brut`;
  }

  function setBusy(busy) {
    state.busy = busy;
    updateControls();
    if (!busy && state.refreshPending) {
      state.refreshPending = false;
      void refreshLibrary();
    }
  }

  function updateDirty() {
    stopLocalSpeech('Lecture arrêtée : le texte ouvert a été modifié.');
    state.dirty = ui['document-title'].value !== state.snapshot.title
      || ui['document-body'].value !== state.snapshot.body;
    if (!state.conflict) {
      status('save-status', state.dirty ? 'unsaved' : (state.current ? 'saved' : 'unsaved'),
        state.dirty ? 'Modifications non enregistrées.'
          : (state.current ? 'Version enregistrée dans ce navigateur.' : 'Nouveau brouillon — pas encore enregistré.'));
    }
    updateControls();
  }

  function discardAllowed() {
    return !state.dirty || window.confirm('Vous avez des modifications non enregistrées. Les abandonner ?');
  }

  function validRecord(record) {
    return record && typeof record.id === 'string' && typeof record.title === 'string'
      && typeof record.body === 'string' && ['draft', 'document'].includes(record.kind)
      && Number.isSafeInteger(record.revision) && record.revision > 0
      && typeof record.createdAt === 'string' && typeof record.updatedAt === 'string';
  }

  // A delete followed by restore can recreate the same ID and revision. Compare
  // the full persisted snapshot, including restore identity, before a write/delete.
  function sameStoredVersion(saved, expected) {
    return validRecord(saved) && coreEquals(saved, expected)
      && saved.restoreKey === expected.restoreKey;
  }

  function loadIntoEditor(record = null) {
    stopLocalSpeech('Lecture arrêtée : le contenu de l’éditeur a changé.');
    state.current = record;
    state.conflict = null;
    ui['document-title'].value = record ? record.title : '';
    ui['document-body'].value = record ? record.body : '';
    state.snapshot = { title: ui['document-title'].value, body: ui['document-body'].value };
    state.dirty = false;
    ui['document-kind'].textContent = record && record.kind === 'document' ? 'Document importé' : 'Brouillon';
    ui['document-kind'].dataset.kind = record ? record.kind : 'draft';
    if (record && record.sourceName) ui['document-kind'].dataset.sourceName = record.sourceName;
    else delete ui['document-kind'].dataset.sourceName;
    status('save-status', record ? 'saved' : 'unsaved', record
      ? 'Version enregistrée dans ce navigateur.' : 'Nouveau brouillon — pas encore enregistré.');
    updateControls();
  }

  function storageLost() {
    state.db = null;
    status('storage-status', 'error', 'Stockage interrompu. Vos modifications ouvertes restent dans l’éditeur. Exportez-les ou cliquez sur « Actualiser les textes » pour réessayer.');
    updateControls();
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let request;
      try { request = window.indexedDB.open(DB_NAME, DB_VERSION); }
      catch (error) { reject(error); return; }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      };
      request.onblocked = () => {
        settled = true;
        const error = new Error('L’ouverture du stockage attend la fermeture d’un autre onglet. Gardez votre texte ouvert ou exportez-le, fermez l’autre onglet puis actualisez la liste.');
        error.name = 'StorageBlockedError';
        reject(error);
      };
      request.onerror = () => { settled = true; reject(request.error); };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true;
        const db = request.result;
        db.onversionchange = () => { db.close(); if (state.db === db) storageLost(); };
        db.onclose = () => { if (state.db === db) storageLost(); };
        resolve(db);
      };
    });
  }

  // The promise resolves only on transaction.complete, never on an individual put/delete success.
  function transaction(mode, work) {
    return new Promise((resolve, reject) => {
      if (!state.db) { reject(new DOMException('Storage unavailable', 'InvalidStateError')); return; }
      let tx;
      let result;
      let failure;
      try { tx = state.db.transaction(STORE_NAME, mode); }
      catch (error) { reject(error); return; }
      const abort = (error) => {
        failure = error;
        try { tx.abort(); } catch (_) { reject(error); }
      };
      tx.oncomplete = () => failure ? reject(failure) : resolve(result);
      tx.onabort = () => reject(failure || tx.error || new DOMException('Transaction aborted', 'AbortError'));
      tx.onerror = () => { failure = failure || tx.error; };
      try { work(tx.objectStore(STORE_NAME), (value) => { result = value; }, abort); }
      catch (error) { abort(error); }
    });
  }

  async function initialiseStorage() {
    if (state.db) return true;
    if (state.opening) return state.opening;
    status('storage-status', 'opening', 'Ouverture du stockage de ce navigateur…');
    state.opening = (async () => {
      try {
        state.db = await openDatabase();
        status('storage-status', 'ready', 'Enregistrement local disponible dans ce navigateur.');
        updateControls();
        await refreshLibrary();
        return true;
      } catch (error) {
        status('storage-status', 'error', describeStorageError(error));
        updateControls();
        return false;
      } finally { state.opening = null; }
    })();
    return state.opening;
  }

  function normalized(value) {
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr-FR');
  }

  function renderLibrary() {
    const query = normalized(ui['search-input'].value.trim());
    const filtered = state.records.filter((record) => !query || normalized(`${record.title}\n${record.body}`).includes(query));
    const fragment = document.createDocumentFragment();
    for (const record of filtered) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-item';
      button.dataset.recordId = record.id;
      button.dataset.recordKind = record.kind;
      button.setAttribute('aria-current', state.current && state.current.id === record.id ? 'true' : 'false');
      const title = document.createElement('span');
      title.className = 'text-item-title';
      title.textContent = record.title;
      const meta = document.createElement('span');
      meta.className = 'text-item-meta';
      const date = new Date(record.updatedAt);
      meta.textContent = `${record.kind === 'document' ? 'Document' : 'Brouillon'} · ${Number.isNaN(date.getTime()) ? 'date inconnue' : date.toLocaleDateString('fr-FR')}`;
      button.append(title, meta);
      button.addEventListener('click', () => { void openRecord(record.id); });
      item.append(button);
      fragment.append(item);
    }
    if (!filtered.length) {
      const empty = document.createElement('li');
      empty.className = 'empty-state';
      empty.textContent = query ? 'Aucun texte ne correspond à cette recherche.'
        : (state.db ? 'Vos textes enregistrés apparaîtront ici.' : 'La liste sera disponible lorsque le stockage local pourra être ouvert.');
      fragment.append(empty);
    }
    ui['document-list'].replaceChildren(fragment);
    ui['library-count'].textContent = `${filtered.length} texte${filtered.length === 1 ? '' : 's'}${query ? ` sur ${state.records.length}` : ''}`;
    updateControls();
  }

  async function refreshLibrary() {
    if (!state.db) { renderLibrary(); return; }
    const requestNumber = ++state.listRequest;
    try {
      const rows = await transaction('readonly', (store, done) => {
        const request = store.getAll();
        request.onsuccess = () => done(request.result);
      });
      if (requestNumber !== state.listRequest) return;
      state.records = rows.filter(validRecord).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      if (rows.length !== state.records.length) showError('Certains éléments du stockage sont illisibles et ne sont pas affichés. Aucun élément n’a été supprimé.');
      if (state.current && !state.busy) {
        const current = state.records.find((record) => record.id === state.current.id);
        if (!sameStoredVersion(current, state.current)) {
          state.conflict = new ConflictError(!current);
          status('save-status', 'conflict', state.conflict.message);
        }
      }
      renderLibrary();
    } catch (error) {
      showError(`La liste des textes n’a pas pu être actualisée. ${describeStorageError(error)}`);
    }
  }

  async function openRecord(id, allowMissing = false) {
    if (state.busy || !discardAllowed()) return;
    clearError();
    setBusy(true);
    try {
      const record = await transaction('readonly', (store, done) => {
        const request = store.get(id);
        request.onsuccess = () => done(request.result);
      });
      if (!record && allowMissing) {
        loadIntoEditor();
        status('save-status', 'unsaved', 'Le texte enregistré a été supprimé. Vous pouvez commencer un nouveau brouillon.');
      } else if (!validRecord(record)) {
        throw new Error('Ce texte n’est plus disponible dans le stockage. Votre éditeur n’a pas été remplacé.');
      } else loadIntoEditor(record);
    } catch (error) { showError(error.message || describeStorageError(error)); }
    finally { setBusy(false); await refreshLibrary(); }
  }

  function newId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function broadcastChange() {
    try { if (channel) channel.postMessage({ type: 'changed' }); } catch (_) { /* Other tabs also refresh on focus. */ }
  }

  async function saveCurrent(asCopy = false) {
    if (state.busy || !state.db) return;
    clearError();
    const body = ui['document-body'].value;
    if (encoder.encode(body).byteLength > MAX_TEXT_BYTES) {
      showError('Ce texte dépasse la limite de 1 Mio. Exportez-le, puis répartissez-le en plusieurs textes pour l’enregistrer ici.');
      status('save-status', 'error', 'Texte trop volumineux — non enregistré.');
      return;
    }
    const previous = asCopy ? null : state.current;
    const now = new Date().toISOString();
    let title = truncateText(ui['document-title'].value.trim(), 160) || 'Sans titre';
    if (asCopy) title = `${truncateText(title, 150)} — copie`;
    let record;
    try {
      record = {
        id: previous ? previous.id : newId(),
        kind: state.current ? state.current.kind : (ui['document-kind'].dataset.kind || 'draft'),
        title, body, revision: previous ? previous.revision + 1 : 1,
        createdAt: previous ? previous.createdAt : now, updatedAt: now,
      };
      const sourceName = state.current ? state.current.sourceName : ui['document-kind'].dataset.sourceName;
      if (sourceName) record.sourceName = sourceName;
      // Editing an imported version must not make the same backup duplicate it.
      if (previous && /^[a-f0-9]{64}$/.test(previous.restoreKey || '')) record.restoreKey = previous.restoreKey;
      if (!Number.isSafeInteger(record.revision)) throw new Error('Revision limit reached');
    } catch (error) { showError(describeStorageError(error)); return; }
    setBusy(true);
    status('save-status', 'saving', 'Enregistrement en cours…');
    try {
      await transaction('readwrite', (store, done, abort) => {
        const request = store.get(record.id);
        request.onsuccess = () => {
          try {
            const saved = request.result;
            if (previous && !sameStoredVersion(saved, previous)) {
              abort(new ConflictError(!saved)); return;
            }
            if (!previous && saved) { abort(new ConflictError()); return; }
            store.put(record);
            done(record);
          } catch (error) { abort(error); }
        };
      });
      loadIntoEditor(record);
      status('save-status', 'saved', 'Enregistré dans ce navigateur. Exportez une copie pour votre sauvegarde.');
      broadcastChange();
    } catch (error) {
      if (error.name === 'ConflictError') {
        state.conflict = error;
        status('save-status', 'conflict', error.message);
      } else {
        status('save-status', 'error', 'Enregistrement non confirmé. Votre texte reste dans l’éditeur.');
        showError(describeStorageError(error));
      }
    } finally { setBusy(false); await refreshLibrary(); }
  }

  async function deleteCurrent() {
    if (state.busy || !state.db || !state.current) return;
    const previous = state.current;
    if (!window.confirm(`Supprimer « ${previous.title} » de ce navigateur ? Les modifications ouvertes seront abandonnées. Exportez une copie avant de supprimer si vous souhaitez la conserver.`)) return;
    clearError();
    setBusy(true);
    try {
      await transaction('readwrite', (store, done, abort) => {
        const request = store.get(previous.id);
        request.onsuccess = () => {
          try {
            const saved = request.result;
            if (saved && !sameStoredVersion(saved, previous)) {
              abort(new ConflictError()); return;
            }
            if (saved) store.delete(previous.id);
            done(true);
          } catch (error) { abort(error); }
        };
      });
      loadIntoEditor();
      ui['document-kind'].dataset.kind = 'draft';
      delete ui['document-kind'].dataset.sourceName;
      status('save-status', 'unsaved', 'Texte supprimé de ce navigateur. Aucun nouveau brouillon n’a été enregistré.');
      broadcastChange();
    } catch (error) {
      if (error.name === 'ConflictError') {
        state.conflict = error;
        status('save-status', 'conflict', 'Suppression annulée : le texte a changé dans un autre onglet. Rechargez la version enregistrée avant de décider.');
      } else showError(`Suppression non confirmée. ${describeStorageError(error)}`);
    } finally { setBusy(false); await refreshLibrary(); }
  }

  async function importText(file) {
    if (!file || state.busy || !discardAllowed()) return;
    clearError();
    if (!/\.(txt|md)$/i.test(file.name)) { showError('Choisissez un fichier .txt ou .md encodé en UTF-8.'); return; }
    if (file.size > MAX_TEXT_BYTES) { showError('Ce fichier dépasse la limite de 1 Mio. Aucun document n’a été importé.'); return; }
    setBusy(true);
    let loaded = false;
    try {
      const buffer = await file.arrayBuffer();
      const body = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      if (body.includes('\0')) throw new Error('Binary text');
      loadIntoEditor();
      ui['document-title'].value = truncateText(file.name.replace(/\.(txt|md)$/i, ''), 160) || 'Document importé';
      ui['document-body'].value = body;
      ui['document-kind'].textContent = 'Document importé';
      ui['document-kind'].dataset.kind = 'document';
      ui['document-kind'].dataset.sourceName = file.name;
      updateDirty();
      loaded = true;
    } catch (_) { showError('Lecture impossible : choisissez un fichier texte UTF-8 valide. Le texte précédent a été conservé.'); }
    finally { setBusy(false); }
    if (loaded && state.db) await saveCurrent();
    else if (loaded) showError('Le document est ouvert, mais le stockage est indisponible. Exportez-le si vous le modifiez avant de quitter.');
  }

  function exportCurrent() {
    clearError();
    try {
      const title = truncateText((ui['document-title'].value.trim() || 'texte-purama')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-'), 80).replace(/[. ]+$/g, '') || 'texte-purama';
      const sourceName = state.current ? state.current.sourceName : ui['document-kind'].dataset.sourceName;
      const extension = sourceName && /\.md$/i.test(sourceName) ? '.md' : '.txt';
      const blob = new Blob([ui['document-body'].value], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${title}${extension}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      // Export is not a storage commit: leave the dirty state and navigation warning intact.
    } catch (_) { showError('L’export n’a pas pu être lancé. Copiez votre texte avant de quitter cette page.'); }
  }


  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    try {
      anchor.href = url;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
    } finally {
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  async function backupLibrary() {
    if (state.busy || !state.db) return;
    clearError();
    setBusy(true);
    status('backup-status', 'preparing', 'Préparation de la sauvegarde des textes enregistrés…');
    const exportedAt = new Date().toISOString();
    try {
      // One readonly cursor provides a consistent snapshot, independent of the search filter.
      // Bound the collected data before building the archive; never silently omit a row.
      const rows = await transaction('readonly', (store, done, abort) => {
        const records = [];
        const headerBytes = encoder.encode(serializeBackup([], exportedAt)).byteLength;
        let bytes = headerBytes;
        const request = store.openCursor();
        request.onsuccess = () => {
          try {
            const cursor = request.result;
            if (!cursor) { done(records); return; }
            if (records.length >= MAX_BACKUP_RECORDS) throw new Error('La sauvegarde est limitée à 2 000 textes. Exportez les autres textes séparément.');
            const row = cursor.value;
            // Use the serializer's projection: internal metadata is not part of the archive.
            bytes += encoder.encode(serializeBackup([row], exportedAt)).byteLength - headerBytes + (records.length ? 1 : 0);
            if (bytes > MAX_BACKUP_BYTES) throw new Error('La bibliothèque dépasse la limite de 32 Mio par sauvegarde. Exportez les textes séparément.');
            records.push(row);
            cursor.continue();
          } catch (error) { abort(error); }
        };
      });
      const text = serializeBackup(rows, exportedAt);
      const filename = `purama-textes-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      downloadBlob(new Blob([text], { type: 'application/json;charset=utf-8' }), filename);
      status('backup-status', 'success', `Téléchargement lancé : ${rows.length} texte${rows.length === 1 ? '' : 's'} enregistré${rows.length === 1 ? '' : 's'}. Vérifiez le fichier téléchargé. Les modifications non enregistrées de l’éditeur ne sont pas incluses.`);
    } catch (error) {
      status('backup-status', 'error', 'Sauvegarde non créée. Aucun texte enregistré n’a été modifié.');
      showError(`Sauvegarde impossible. ${error.name === 'BackupValidationError' || error.message?.includes('sauvegarde') ? error.message : describeStorageError(error)}`);
    } finally { setBusy(false); }
  }

  function clearRestorePreview() {
    state.pendingRestore = null;
    ui['restore-preview'].hidden = true;
    ui['restore-summary'].textContent = '';
    updateControls();
  }

  async function selectBackup(file) {
    if (!file || state.busy) return;
    clearError();
    clearRestorePreview();
    setBusy(true);
    status('backup-status', 'preparing', 'Vérification de la sauvegarde… Aucun texte n’est encore ajouté.');
    try {
      if (!/\.json$/i.test(file.name)) throw new Error('Choisissez une sauvegarde PURAMA au format .json.');
      if (file.size > MAX_BACKUP_BYTES) throw new Error('La sauvegarde dépasse la limite de 32 Mio.');
      const bytes = await file.arrayBuffer();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const archive = parseBackup(text);
      const preparedRecords = await prepareRestore(archive);
      state.pendingRestore = preparedRecords;
      const date = new Date(archive.exportedAt).toLocaleString('fr-FR');
      ui['restore-summary'].textContent = `${archive.records.length} texte${archive.records.length === 1 ? '' : 's'} dans « ${file.name} » · sauvegarde du ${date}. Les textes existants et le contenu ouvert dans l’éditeur seront conservés.`;
      ui['restore-preview'].hidden = false;
      status('backup-status', 'preview', 'Sauvegarde vérifiée. Cliquez sur « Ajouter ces textes » pour les restaurer ici.');
    } catch (error) {
      status('backup-status', 'error', 'Sauvegarde refusée. Aucun texte n’a été ajouté ni remplacé.');
      showError(error instanceof TypeError ? 'Lecture impossible : la sauvegarde doit être un fichier JSON UTF-8 valide.' : error.message || 'La sauvegarde n’a pas pu être lue.');
    } finally { setBusy(false); }
  }

  async function restoreLibrary() {
    if (state.busy || !state.db || !state.pendingRestore) return;
    const preparedRecords = state.pendingRestore;
    clearError();
    setBusy(true);
    status('backup-status', 'preparing', 'Restauration en cours… Attendez la confirmation avant de fermer cette page.');
    try {
      // Reads, conflict decisions and all additions share one readwrite transaction.
      // No asynchronous hashing or user interaction can suspend this transaction.
      const result = await transaction('readwrite', (store, done, abort) => {
        const incomingIds = new Set(preparedRecords.map(({ record }) => record.id));
        const existing = [];
        const request = store.openCursor();
        request.onsuccess = () => {
          try {
            const cursor = request.result;
            if (cursor) {
              const row = cursor.value;
              existing.push(incomingIds.has(cursor.primaryKey) && validRecord(row) && row.id === cursor.primaryKey
                ? row : { id: cursor.primaryKey, restoreKey: row?.restoreKey });
              cursor.continue();
              return;
            }
            const plan = planRestore(preparedRecords, existing, newId);
            for (const record of plan.additions) store.add(record);
            done({ added: plan.additions.length, skipped: plan.skipped });
          } catch (error) { abort(error); }
        };
      });
      clearRestorePreview();
      status('backup-status', 'success', `Restauration terminée : ${result.added} ajouté${result.added === 1 ? '' : 's'}, ${result.skipped} déjà présent${result.skipped === 1 ? '' : 's'}. Votre éditeur est conservé.`);
      if (result.added) broadcastChange();
    } catch (error) {
      status('backup-status', 'error', 'Restauration annulée : aucun texte n’a été ajouté. Les textes existants et votre éditeur sont conservés.');
      showError(`La restauration n’a pas pu être confirmée. ${describeStorageError(error)}`);
    } finally { setBusy(false); await refreshLibrary(); }
  }

  // Voice metadata must explicitly identify a local French service. Never use
  // the browser's default voice or a remote/cloud fallback for this workspace.
  function localFrenchVoices(synth) {
    return Array.from(synth.getVoices()).filter((voice) => voice
      && voice.localService === true && typeof voice.lang === 'string'
      && /^fr(?:[-_]|$)/i.test(voice.lang));
  }

  function sameLocalVoice(left, right) {
    return left && right && left.localService === true && right.localService === true
      && left.voiceURI === right.voiceURI && left.name === right.name && left.lang === right.lang;
  }

  function clearSpeechUtterance() {
    clearTimeout(speech.timer);
    speech.timer = null;
    if (speech.utterance) {
      speech.utterance.onstart = null;
      speech.utterance.onend = null;
      speech.utterance.onerror = null;
    }
    speech.utterance = null;
  }

  function stopLocalSpeech(message = 'Lecture arrêtée.', result = 'stopped') {
    if (!speech.run && !speech.stopUnconfirmed) return true;
    // Invalidate first: cancel() can synchronously emit delayed speech events.
    speech.generation += 1;
    speech.run = null;
    clearSpeechUtterance();
    // Keep the original synth and a usable stop button until cancellation returns.
    // voiceschanged may fire inside cancel(): it must not erase this uncertainty.
    speech.stopUnconfirmed = true;
    try { speech.synth.cancel(); }
    catch (_) {
      status('speech-status', 'stop-unconfirmed', 'L’arrêt de la voix n’a pas pu être confirmé par le navigateur. Réessayez l’arrêt ; fermez cette page si la lecture continue.');
      updateControls();
      return false;
    }
    speech.stopUnconfirmed = false;
    status('speech-status', result, message);
    updateControls();
    return true;
  }

  function refreshLocalVoices() {
    // Availability updates never acknowledge an unconfirmed stop. Only another
    // explicit cancellation attempt can clear it, using the preserved synth.
    if (speech.stopUnconfirmed) { updateControls(); return; }
    try {
      const synth = window.speechSynthesis;
      if (!synth || typeof window.SpeechSynthesisUtterance !== 'function'
        || typeof synth.getVoices !== 'function' || typeof synth.speak !== 'function'
        || typeof synth.cancel !== 'function') {
        speech.voice = null;
        if (!stopLocalSpeech('Lecture arrêtée : la synthèse vocale est indisponible.', 'error')) return;
        speech.synth = null;
        status('speech-status', 'unsupported', 'La lecture vocale locale n’est pas disponible dans ce navigateur. Vos textes restent utilisables.');
        updateControls();
        return;
      }
      if (speech.synth && speech.synth !== synth
        && !stopLocalSpeech('Lecture arrêtée : le service vocal a changé.', 'error')) return;
      speech.synth = synth;
      const voices = localFrenchVoices(synth);
      if (speech.run) {
        const current = voices.find((voice) => sameLocalVoice(voice, speech.run.voice));
        if (current) {
          speech.voice = current;
          speech.run.voice = current;
          return;
        }
        if (!stopLocalSpeech('Lecture arrêtée : la voix française locale n’est plus disponible.', 'error')) return;
      }
      speech.voice = voices.find((voice) => /^fr[-_]fr$/i.test(voice.lang))
        || voices.find((voice) => voice.default) || voices[0] || null;
      status('speech-status', speech.voice ? 'ready' : 'unavailable', speech.voice
        ? `Voix française locale disponible : ${speech.voice.name}. Lancez la lecture quand vous le souhaitez.`
        : 'Aucune voix française locale disponible. Installez une voix française sur votre appareil, puis rouvrez cet espace. Aucune voix distante n’est utilisée.');
      updateControls();
    } catch (_) {
      speech.voice = null;
      if (!stopLocalSpeech('Lecture arrêtée : les voix locales n’ont pas pu être vérifiées.', 'error')) return;
      status('speech-status', 'error', 'Les voix locales n’ont pas pu être vérifiées. La lecture reste indisponible ; vos textes sont conservés.');
      updateControls();
    }
  }

  function speechChunkEnd(run) {
    const { text, offset } = run;
    let end = Math.min(offset + SPEECH_CHUNK_UNITS, text.length);
    if (end === text.length) return end;
    // Prefer a nearby word boundary without dropping whitespace or punctuation.
    const windowText = text.slice(offset, end);
    const breakAt = Math.max(windowText.lastIndexOf(' '), windowText.lastIndexOf('\n'), windowText.lastIndexOf('\t'));
    if (breakAt >= SPEECH_CHUNK_UNITS / 2) end = offset + breakAt + 1;
    if (run.graphemes) {
      const containing = run.graphemes.containing(end);
      if (containing && containing.index < end) end = containing.index;
    } else {
      // Older engines still preserve every Unicode code point and CRLF pair.
      const previous = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if ((previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
        || (previous === 13 && next === 10)) end -= 1;
    }
    if (end <= offset) throw new Error('A character sequence exceeds the bounded speech segment');
    return end;
  }

  function speakNextChunk(run) {
    if (speech.run !== run || speech.generation !== run.generation) return;
    if (run.offset >= run.text.length) {
      speech.run = null;
      clearSpeechUtterance();
      status('speech-status', 'complete', 'Lecture terminée : le navigateur a confirmé la fin de chaque passage.');
      updateControls();
      return;
    }
    try {
      // Recheck before every segment, including after an OS voice-list update.
      const voice = localFrenchVoices(speech.synth).find((item) => sameLocalVoice(item, run.voice));
      if (!voice) {
        speech.voice = null;
        stopLocalSpeech('Lecture arrêtée : la voix française locale n’est plus disponible.', 'error');
        return;
      }
      const end = speechChunkEnd(run);
      const utterance = new window.SpeechSynthesisUtterance(run.text.slice(run.offset, end));
      utterance.voice = voice;
      utterance.lang = voice.lang;
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.volume = 1;
      speech.utterance = utterance;
      const current = () => speech.run === run && speech.generation === run.generation
        && speech.utterance === utterance;
      utterance.onstart = () => {
        if (current()) status('speech-status', 'speaking', `Lecture locale en cours — ${voice.name}.`);
      };
      utterance.onend = () => {
        if (!current()) return;
        clearSpeechUtterance();
        run.offset = end;
        // Only one utterance is queued; delayed callbacks cannot resume a stopped run.
        queueMicrotask(() => speakNextChunk(run));
      };
      utterance.onerror = () => {
        if (current()) stopLocalSpeech('La lecture locale a échoué. Votre texte est conservé ; vous pouvez réessayer.', 'error');
      };
      speech.timer = setTimeout(() => {
        if (current()) stopLocalSpeech('Lecture interrompue : le navigateur n’a pas confirmé la fin du passage. Votre texte est conservé.', 'error');
      }, SPEECH_TIMEOUT_MS);
      speech.synth.speak(utterance);
    } catch (_) {
      stopLocalSpeech('La lecture locale n’a pas pu démarrer ou poursuivre ce passage. Votre texte est conservé.', 'error');
    }
  }

  function startLocalSpeech() {
    if (state.busy || speech.run || speech.stopUnconfirmed) return;
    refreshLocalVoices();
    if (!speech.voice || !speech.synth) return;
    // Validate only on explicit playback, never while typing in a large document.
    const text = ui['document-body'].value;
    if (!text.trim()) {
      status('speech-status', 'empty', 'Ajoutez du texte à lire dans l’éditeur.');
      return;
    }
    if (text.length > MAX_TEXT_BYTES || encoder.encode(text).byteLength > MAX_TEXT_BYTES) {
      status('speech-status', 'error', 'Ce texte dépasse la limite de 1 Mio pour la lecture locale. Répartissez-le en plusieurs textes.');
      return;
    }
    const run = { generation: ++speech.generation, text, offset: 0, voice: speech.voice, graphemes: null };
    try {
      if (typeof Intl.Segmenter === 'function') {
        run.graphemes = new Intl.Segmenter('fr', { granularity: 'grapheme' }).segment(text);
      }
    } catch (_) {
      status('speech-status', 'error', 'La lecture locale n’a pas pu être préparée. Votre texte est conservé.');
      return;
    }
    try { speech.synth.cancel(); }
    catch (_) {
      speech.stopUnconfirmed = true;
      status('speech-status', 'stop-unconfirmed', 'L’arrêt préalable de la voix n’a pas pu être confirmé. Réessayez l’arrêt avant de lancer une nouvelle lecture.');
      updateControls();
      return;
    }
    speech.run = run;
    status('speech-status', 'starting', `Démarrage de la voix locale — ${run.voice.name}…`);
    updateControls();
    speakNextChunk(run);
  }

  function queryWorker(worker, type = 'PURAMA_OFFLINE_STATUS', timeout = 3000) {
    return new Promise((resolve) => {
      const ports = new MessageChannel();
      let settled = false;
      const finish = (ready) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ports.port1.close();
        ports.port2.close();
        resolve(ready);
      };
      const timer = setTimeout(() => finish(false), timeout);
      ports.port1.onmessage = (event) => finish(event.data && event.data.type === 'PURAMA_OFFLINE_STATUS'
        && event.data.version === CACHE_NAME && event.data.ready === true);
      try { worker.postMessage({ type }, [ports.port2]); }
      catch (_) { finish(false); }
    });
  }

  async function prepared(registration) {
    if (!registration || !registration.active || registration.active.state !== 'activated') return false;
    const script = new URL(registration.active.scriptURL);
    if (script.origin !== location.origin || script.pathname !== '/sw.js') return false;
    if (!await queryWorker(registration.active) || !await caches.has(CACHE_NAME)) return false;
    const cache = await caches.open(CACHE_NAME);
    const responses = await Promise.all(REQUIRED_ASSETS.map((path) => cache.match(new URL(path, location.origin).href)));
    return responses.every((response) => response && response.ok);
  }

  async function inspectPreparation(registration) {
    const check = ++state.preparationCheck;
    if (!('serviceWorker' in navigator) || !('caches' in window) || !window.isSecureContext) {
      status('preparation-status', 'unsupported', 'La préparation hors connexion n’est pas disponible dans ce contexte. Utilisez une adresse HTTPS ou localhost dans un navigateur compatible.');
      ui['prepare-offline'].disabled = true;
      return false;
    }
    try {
      const reg = registration || await navigator.serviceWorker.getRegistration('/');
      const ready = await prepared(reg);
      if (check !== state.preparationCheck) return ready;
      status('preparation-status', ready ? 'ready' : 'missing', ready
        ? 'Espace prêt hors connexion : le gestionnaire actif et les fichiers locaux ont été vérifiés. Cette préparation doit être refaite si les données du site sont effacées.'
        : 'Accès hors connexion non confirmé. Préparez cet espace pendant qu’une connexion est disponible.');
      return ready;
    } catch (_) {
      if (check === state.preparationCheck) status('preparation-status', 'error', 'La préparation hors connexion n’a pas pu être vérifiée. Vous pouvez travailler ici et exporter vos textes.');
      return false;
    }
  }

  function withTimeout(promise, milliseconds) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Preparation timeout')), milliseconds);
      promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }

  function waitForActivation(registration) {
    // active can already exist while its activation event is still running.
    const worker = registration.installing || registration.waiting || registration.active;
    if (!worker || worker.state === 'activated') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Activation timeout')), 12000);
      const listener = () => {
        if (worker.state === 'activated') finish();
        else if (worker.state === 'redundant') finish(new Error('Installation failed'));
      };
      function finish(error) {
        clearTimeout(timer);
        worker.removeEventListener('statechange', listener);
        if (error) reject(error); else resolve();
      }
      worker.addEventListener('statechange', listener);
      listener();
    });
  }

  async function prepareOffline() {
    if (state.preparing) return;
    state.preparing = true;
    state.preparationCheck += 1;
    ui['prepare-offline'].disabled = true;
    status('preparation-status', 'checking', 'Préparation de cet espace : téléchargement des fichiers et vérification…');
    try {
      const registration = await withTimeout(navigator.serviceWorker.register('/sw.js', { scope: '/' }), 15000);
      try { await withTimeout(registration.update(), 10000); } catch (_) { /* An already prepared active worker can still be verified. */ }
      await waitForActivation(registration);
      if (!registration.active || registration.active.state !== 'activated') {
        throw new Error('Active service worker not ready');
      }
      await queryWorker(registration.active, 'PURAMA_OFFLINE_PREPARE', 12000);
      await inspectPreparation(registration);
    } catch (_) {
      if (!await inspectPreparation()) status('preparation-status', 'error', 'Préparation non confirmée. Une connexion au site et un stockage disponible sont nécessaires ; réessayez lorsque ces conditions sont réunies.');
    } finally {
      state.preparing = false;
      ui['prepare-offline'].disabled = ui['preparation-status'].dataset.state === 'unsupported';
    }
  }

  ui['speak-text'].addEventListener('click', startLocalSpeech);
  ui['stop-speech'].addEventListener('click', () => stopLocalSpeech());
  window.addEventListener('pagehide', () => stopLocalSpeech());
  ui['document-title'].addEventListener('input', updateDirty);
  ui['document-body'].addEventListener('input', updateDirty);
  ui['save-document'].addEventListener('click', () => { void saveCurrent(); });
  ui['save-copy'].addEventListener('click', () => { void saveCurrent(true); });
  ui['reload-document'].addEventListener('click', () => { if (state.current) void openRecord(state.current.id, true); });
  ui['delete-document'].addEventListener('click', () => { void deleteCurrent(); });
  ui['export-document'].addEventListener('click', exportCurrent);
  ui['backup-library'].addEventListener('click', () => { void backupLibrary(); });
  ui['restore-file'].addEventListener('change', () => {
    const file = ui['restore-file'].files && ui['restore-file'].files[0];
    ui['restore-file'].value = '';
    void selectBackup(file);
  });
  ui['confirm-restore'].addEventListener('click', () => { void restoreLibrary(); });
  ui['cancel-restore'].addEventListener('click', () => {
    if (state.busy) return;
    clearError();
    clearRestorePreview();
    status('backup-status', 'idle', 'Restauration annulée. Aucun texte n’a été ajouté.');
  });
  ui['prepare-offline'].addEventListener('click', () => { void prepareOffline(); });
  ui['new-draft'].addEventListener('click', () => {
    if (!discardAllowed()) return;
    clearError();
    loadIntoEditor();
    ui['document-kind'].dataset.kind = 'draft';
    delete ui['document-kind'].dataset.sourceName;
    renderLibrary();
    ui['document-title'].focus();
  });
  ui['import-file'].addEventListener('change', () => {
    const file = ui['import-file'].files && ui['import-file'].files[0];
    ui['import-file'].value = '';
    void importText(file);
  });
  ui['search-input'].addEventListener('input', renderLibrary);
  ui['refresh-library'].addEventListener('click', async () => {
    clearError();
    if (await initialiseStorage()) await refreshLibrary();
  });
  window.addEventListener('beforeunload', (event) => {
    if (!state.dirty && !state.busy) return;
    event.preventDefault();
    event.returnValue = '';
  });
  const externalRefresh = () => {
    if (state.busy) state.refreshPending = true;
    else void refreshLibrary();
  };
  window.addEventListener('focus', externalRefresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) externalRefresh(); });
  try {
    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel('purama-offline-workspace-updates');
      channel.onmessage = (event) => { if (event.data && event.data.type === 'changed') externalRefresh(); };
    }
  } catch (_) { /* Focus and manual refresh remain available; CAS does not depend on broadcasts. */ }
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('controllerchange', () => { void inspectPreparation(); });
  loadIntoEditor();
  renderLibrary();
  void initialiseStorage();
  void inspectPreparation();
  refreshLocalVoices();
  try { speech.synth?.addEventListener('voiceschanged', refreshLocalVoices); }
  catch (_) { /* Playback also rechecks the current voices on every explicit click. */ }
})();
