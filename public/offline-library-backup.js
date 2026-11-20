/**
 * Portable, data-only backups for the offline text library.
 * This module never reads storage, performs network requests, or interprets HTML.
 */
export const MAX_BACKUP_BYTES = 32 * 1024 * 1024;
export const MAX_BACKUP_RECORDS = 2000;

const FORMAT = "purama-offline-texts";
const VERSION = 1;
const MAX_BODY_BYTES = 1024 * 1024;
const CORE_KEYS = ["id", "kind", "title", "body", "revision", "createdAt", "updatedAt"];
const RECORD_KEYS = new Set([...CORE_KEYS, "sourceName"]);
const ARCHIVE_KEYS = new Set(["format", "version", "exportedAt", "records"]);
const ID_PATTERN = /^[-A-Za-z0-9_:.]{1,128}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const RESTORED_SUFFIX = " — restauré";
const encoder = new TextEncoder();
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

class BackupValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackupValidationError";
  }
}

function fail(message) {
  throw new BackupValidationError(message);
}

/** Count UTF-8 bytes without allocating an unbounded encoded copy. */
function utf8Length(text, limit) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

function assertObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("Un objet de sauvegarde est invalide.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("Le prototype d’un objet est interdit.");
  }
}

function dataValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !own(descriptor, "value")) {
    fail("Un champ obligatoire est absent ou invalide.");
  }
  return descriptor.value;
}

function assertKeys(value, allowed, required) {
  assertObject(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      fail("La sauvegarde contient un champ inconnu ou interdit.");
    }
    dataValue(value, key);
  }
  for (const key of required) {
    if (!own(value, key)) fail("Un champ obligatoire est absent.");
  }
}

function assertDate(value) {
  // toISOString also supports its canonical signed, six-digit year form.
  if (typeof value !== "string" ||
    !/^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail("Une date doit être au format ISO UTC canonique.");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail("Une date de la sauvegarde est invalide.");
  }
}

function recordCopy(value, strict) {
  assertObject(value);
  if (strict) assertKeys(value, RECORD_KEYS, CORE_KEYS);
  // Export projects only these fields; local restore keys and other internals
  // are deliberately neither read nor serialized.
  const record = {
    id: dataValue(value, "id"),
    kind: dataValue(value, "kind"),
    title: dataValue(value, "title"),
    body: dataValue(value, "body"),
    revision: dataValue(value, "revision"),
    createdAt: dataValue(value, "createdAt"),
    updatedAt: dataValue(value, "updatedAt"),
  };
  if (typeof record.id !== "string" || !ID_PATTERN.test(record.id)) {
    fail("Un identifiant de texte est invalide.");
  }
  if (record.kind !== "draft" && record.kind !== "document") {
    fail("Un type de texte est invalide.");
  }
  if (typeof record.title !== "string" || record.title.length < 1 || record.title.length > 160) {
    fail("Un titre doit contenir de 1 à 160 caractères.");
  }
  if (typeof record.body !== "string") fail("Le contenu d’un texte est invalide.");
  if (record.body.length > MAX_BODY_BYTES || utf8Length(record.body, MAX_BODY_BYTES) > MAX_BODY_BYTES) {
    fail("Un texte dépasse la limite de 1 Mio en UTF-8.");
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) {
    fail("Une révision doit être un entier positif sûr.");
  }
  assertDate(record.createdAt);
  assertDate(record.updatedAt);
  // A device clock may move backwards: preserve both timestamps as recorded.
  if (own(value, "sourceName")) {
    const sourceName = dataValue(value, "sourceName");
    if (typeof sourceName !== "string" || sourceName.length > 1024) {
      fail("Un nom de source dépasse la limite de 1 024 caractères ou est invalide.");
    }
    record.sourceName = sourceName;
  }
  return record;
}

function assertRecordList(records) {
  if (!Array.isArray(records)) fail("La liste des textes est invalide.");
  if (records.length > MAX_BACKUP_RECORDS) {
    fail("La sauvegarde dépasse la limite de 2 000 textes.");
  }
}

/**
 * Validate and measure one serialized record at a time. Joining the complete
 * archive happens only after its encoded size has passed the 32 MiB bound.
 */
function collectArchive(records, exportedAt, strict, includeText) {
  assertRecordList(records);
  assertDate(exportedAt);
  const prefix = '{"format":"' + FORMAT + '","version":1,"exportedAt":' +
    JSON.stringify(exportedAt) + ',"records":[';
  let bytes = utf8Length(prefix, MAX_BACKUP_BYTES) + 2; // closing ]}
  const chunks = includeText ? [prefix] : null;
  const copies = [];
  const ids = new Set();
  for (const value of records) {
    const record = recordCopy(value, strict);
    if (ids.has(record.id)) fail("La sauvegarde contient des identifiants de texte dupliqués.");
    ids.add(record.id);
    const encoded = JSON.stringify(record);
    const separator = copies.length ? "," : "";
    bytes += separator.length + utf8Length(encoded, MAX_BACKUP_BYTES - bytes - separator.length);
    if (bytes > MAX_BACKUP_BYTES) fail("La sauvegarde dépasse la limite de 32 Mio en UTF-8.");
    copies.push(record);
    if (chunks) {
      if (separator) chunks.push(separator);
      chunks.push(encoded);
    }
  }
  if (chunks) chunks.push("]}");
  return {
    archive: { format: FORMAT, version: VERSION, exportedAt, records: copies },
    text: chunks ? chunks.join("") : undefined,
  };
}

function archiveCopy(value) {
  assertKeys(value, ARCHIVE_KEYS, ["format", "version", "exportedAt", "records"]);
  if (dataValue(value, "format") !== FORMAT) fail("Ce fichier n’est pas une sauvegarde de textes IAO.");
  if (dataValue(value, "version") !== VERSION) fail("Cette version de sauvegarde n’est pas prise en charge.");
  return collectArchive(dataValue(value, "records"), dataValue(value, "exportedAt"), true, false).archive;
}

export function serializeBackup(records, exportedAt = new Date().toISOString()) {
  return collectArchive(records, exportedAt, false, true).text;
}

export function parseBackup(text) {
  if (typeof text !== "string") fail("Le fichier de sauvegarde doit être du texte.");
  if (text.length > MAX_BACKUP_BYTES || utf8Length(text, MAX_BACKUP_BYTES) > MAX_BACKUP_BYTES) {
    fail("La sauvegarde dépasse la limite de 32 Mio en UTF-8.");
  }
  let archive;
  try {
    archive = JSON.parse(text);
  } catch {
    fail("Le fichier de sauvegarde ne contient pas un JSON valide.");
  }
  return archiveCopy(archive);
}

export async function prepareRestore(archive) {
  const validated = archiveCopy(archive);
  if (!validated.records.length) return [];
  if (!globalThis.crypto?.subtle) {
    fail("La vérification SHA-256 est indisponible dans ce navigateur.");
  }
  const prepared = [];
  // Sequential hashes keep temporary buffers bounded by a single record.
  for (const record of validated.records) {
    let digest;
    try {
      digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(record)));
    } catch {
      fail("La vérification SHA-256 de la sauvegarde a échoué.");
    }
    const restoreKey = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    prepared.push({ record, restoreKey });
  }
  return prepared;
}

export function coreEquals(existing, record) {
  for (const key of CORE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(existing, key);
    if (!descriptor || !own(descriptor, "value") || descriptor.value !== record[key]) return false;
  }
  if (own(existing, "sourceName") !== own(record, "sourceName")) return false;
  if (!own(record, "sourceName")) return true;
  const source = Object.getOwnPropertyDescriptor(existing, "sourceName");
  return Boolean(source && own(source, "value") && source.value === record.sourceName);
}

/** Bound generated titles/filenames without splitting a complete Unicode character. */
export function truncateText(text, limit) {
  if (typeof text !== "string" || !Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError("A string and a non-negative UTF-16 limit are required.");
  }
  if (text.length <= limit) return text;
  let end = limit;
  try {
    if (typeof globalThis.Intl?.Segmenter === "function") {
      const segments = new Intl.Segmenter("fr", { granularity: "grapheme" }).segment(text);
      const containing = segments.containing(end);
      if (containing) end = containing.index;
    }
  } catch { /* Older or partial engines still preserve Unicode pairs below. */ }
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if ((previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) ||
    (previous === 13 && next === 10)) end -= 1;
  return text.slice(0, end);
}

function restoredTitle(title) {
  return truncateText(title, 160 - RESTORED_SUFFIX.length) + RESTORED_SUFFIX;
}

function freshId(reservedIds, createId) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let id;
    try {
      id = createId();
    } catch {
      fail("La création d’un identifiant de restauration a échoué.");
    }
    if (typeof id === "string" && ID_PATTERN.test(id) && !reservedIds.has(id)) return id;
  }
  fail("Impossible de créer un identifiant unique après 8 essais.");
}

/**
 * Compute an insert-only plan. The caller must apply additions with store.add
 * in the same transaction that collected existingRows, then await completion.
 * skipped is a count; additions are complete rows including their restoreKey.
 */
export function planRestore(prepared, existingRows, createId) {
  assertRecordList(prepared);
  if (!Array.isArray(existingRows)) fail("La liste des textes existants est invalide.");
  if (typeof createId !== "function") fail("La création des identifiants est indisponible.");

  const existing = new Map();
  const restoreKeys = new Set();
  for (const row of existingRows) {
    assertObject(row);
    const id = dataValue(row, "id");
    if (typeof id !== "string" || !id) fail("Un identifiant de texte existant est invalide.");
    if (existing.has(id)) fail("La liste existante contient des identifiants dupliqués.");
    existing.set(id, row);
    if (own(row, "restoreKey")) {
      const key = dataValue(row, "restoreKey");
      if (typeof key === "string") restoreKeys.add(key);
    }
  }

  const incomingIds = new Set();
  const incomingKeys = new Set();
  const entries = prepared.map((entry) => {
    assertKeys(entry, new Set(["record", "restoreKey"]), ["record", "restoreKey"]);
    const record = recordCopy(dataValue(entry, "record"), true);
    const restoreKey = dataValue(entry, "restoreKey");
    if (typeof restoreKey !== "string" || !HASH_PATTERN.test(restoreKey)) {
      fail("Une identité de restauration est invalide.");
    }
    if (incomingIds.has(record.id) || incomingKeys.has(restoreKey)) {
      fail("Le plan de restauration contient des identités dupliquées.");
    }
    incomingIds.add(record.id);
    incomingKeys.add(restoreKey);
    return { record, restoreKey };
  });

  // Reserve all original IDs, including those later in the archive.
  const reservedIds = new Set([...existing.keys(), ...incomingIds]);
  const additions = [];
  let skipped = 0;
  for (const { record, restoreKey } of entries) {
    const occupied = existing.get(record.id);
    if (restoreKeys.has(restoreKey) || (occupied && coreEquals(occupied, record))) {
      skipped += 1;
      continue;
    }
    const addition = { ...record, restoreKey };
    if (occupied) {
      addition.id = freshId(reservedIds, createId);
      addition.title = restoredTitle(record.title);
      addition.revision = 1;
    }
    reservedIds.add(addition.id);
    restoreKeys.add(restoreKey);
    additions.push(addition);
  }
  return { additions, skipped };
}
