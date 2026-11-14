import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  MAX_BACKUP_BYTES,
  MAX_BACKUP_RECORDS,
  serializeBackup,
  parseBackup,
  prepareRestore,
  planRestore,
} from "../../public/offline-library-backup.js";

const AT = "2026-11-10T12:34:56.789Z";
const LATER = "2026-11-11T12:34:56.789Z";
const MIB = 1024 * 1024;

function row(overrides = {}) {
  return {
    id: "text-1",
    kind: "draft",
    title: "Titre",
    body: "Texte sauvegardé.",
    revision: 7,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function archive(records = [row()], exportedAt = AT) {
  return { format: "purama-offline-texts", version: 1, exportedAt, records };
}

function invalid(operation, message) {
  assert.throws(operation, (error) => {
    assert.equal(error.name, "BackupValidationError");
    if (message) assert.match(error.message, message);
    return true;
  });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const noIdNeeded = () => assert.fail("La fabrique d’identifiants ne devait pas être appelée.");

test("portable format and literal text round-trip without exporting local internals", () => {
  assert.equal(MAX_BACKUP_BYTES, 32 * MIB);
  assert.equal(MAX_BACKUP_RECORDS, 2000);
  const original = row({
    id: "doc:fr_1.-",
    kind: "document",
    title: "  <b>Été 🛰️</b>  ",
    body: '<script>alert("x")</script>\n<script src="/x"></script>\0 & é 🛰️ \ud800',
    sourceName: "  données <source>.txt  ",
    restoreKey: "a".repeat(64),
    privateState: { ignored: true },
  });
  Object.defineProperty(original, "unreadInternal", {
    enumerable: true,
    get() { throw new Error("An internal field was read"); },
  });
  Object.freeze(original);
  const text = serializeBackup([original], AT);
  const parsed = parseBackup(text);
  assert.deepEqual(Object.keys(parsed), ["format", "version", "exportedAt", "records"]);
  assert.deepEqual(Object.keys(parsed.records[0]), [
    "id", "kind", "title", "body", "revision", "createdAt", "updatedAt", "sourceName",
  ]);
  assert.equal(parsed.records[0].body, original.body);
  assert.equal(parsed.records[0].title, original.title);
  assert.equal(parsed.records[0].sourceName, original.sourceName);
  assert.equal(parsed.records[0].revision, 7);
  assert.equal(parsed.records[0].createdAt, AT);
  assert.equal(parsed.records[0].updatedAt, AT);
  assert.equal(text.includes("restoreKey"), false);
  assert.equal(text.includes("privateState"), false);
  assert.equal(text.includes("unreadInternal"), false);
  assert.equal(Object.hasOwn(original, "restoreKey"), true);
});

test("empty backups and a default canonical export timestamp are supported", async () => {
  const value = parseBackup(serializeBackup([]));
  assert.deepEqual(value.records, []);
  assert.equal(new Date(value.exportedAt).toISOString(), value.exportedAt);
  assert.deepEqual(await prepareRestore(value), []);
  assert.deepEqual(planRestore([], [], noIdNeeded), { additions: [], skipped: 0 });
});

test("malformed JSON, wrong roots, unknown format and future versions are rejected", () => {
  for (const input of ["", "{", "null", "[]", '"string"', "42", '{"records":[]}']) {
    invalid(() => parseBackup(input));
  }
  invalid(() => parseBackup(4));
  invalid(() => parseBackup(JSON.stringify({ ...archive(), format: "other-format" })));
  invalid(() => parseBackup(JSON.stringify({ ...archive(), version: 2 })), /version/);
  invalid(() => parseBackup(JSON.stringify({ ...archive(), version: "1" })), /version/);
  invalid(() => parseBackup(JSON.stringify({ ...archive(), unknown: true })), /champ/);
  invalid(() => parseBackup(JSON.stringify({ ...archive(), records: {} })));
});

test("unknown and prototype-related JSON fields fail closed at both schema levels", () => {
  for (const key of ["__proto__", "prototype", "constructor", "restoreKey", "unexpected"]) {
    const base = JSON.stringify(archive());
    const top = base.slice(0, -1) + ',"' + key + '":{"polluted":true}}';
    invalid(() => parseBackup(top), /champ/);
    const record = JSON.parse(JSON.stringify(row()).slice(0, -1) + ',"' + key + '":{"polluted":true}}');
    invalid(() => parseBackup(JSON.stringify(archive([record]))), /champ/);
  }
  assert.equal({}.polluted, undefined);
});

test("every record field is required and checked without coercion or trimming", () => {
  for (const key of ["id", "kind", "title", "body", "revision", "createdAt", "updatedAt"]) {
    const value = row();
    delete value[key];
    invalid(() => parseBackup(JSON.stringify(archive([value]))));
    invalid(() => serializeBackup([value], AT));
  }
  const changes = [
    { id: "" }, { id: "bad id" }, { id: "café" }, { id: "x".repeat(129) },
    { id: "__proto__ " }, { kind: "file" }, { kind: null },
    { title: "" }, { title: "x".repeat(161) }, { title: 3 },
    { body: null }, { body: {} }, { body: [] },
    { revision: 0 }, { revision: -1 }, { revision: 1.1 },
    { revision: Number.MAX_SAFE_INTEGER + 1 }, { revision: "1" },
    { sourceName: null }, { sourceName: 42 }, { sourceName: "x".repeat(1025) },
  ];
  for (const change of changes) {
    invalid(() => serializeBackup([row(change)], AT));
    invalid(() => parseBackup(JSON.stringify(archive([row(change)]))));
  }
  assert.equal(parseBackup(serializeBackup([row({ title: " ", sourceName: "" })], AT)).records[0].title, " ");
  assert.equal(parseBackup(serializeBackup([row({ id: "__proto__" })], AT)).records[0].id, "__proto__");
});

test("direct archive inputs reject foreign prototypes, accessors and extra symbols", async () => {
  const foreign = Object.assign(Object.create({ inherited: true }), archive());
  await assert.rejects(prepareRestore(foreign), { name: "BackupValidationError" });
  const symbol = archive();
  symbol[Symbol("hidden")] = true;
  await assert.rejects(prepareRestore(symbol), { name: "BackupValidationError" });
  const accessor = row();
  Object.defineProperty(accessor, "body", { enumerable: true, get() { throw new Error("getter executed"); } });
  invalid(() => serializeBackup([accessor], AT));
});

test("dates must be valid canonical ISO, while future dates and clock rollback survive unchanged", async () => {
  for (const value of [
    "2026-02-30T00:00:00.000Z", "2026-11-10", "2026-11-10T12:34:56Z",
    "2026-11-10T12:34:56.789+00:00", "2026-11-10T24:00:00.000Z",
    "2026-11-10T12:34:60.000Z", " 2026-11-10T12:34:56.789Z", null,
  ]) {
    invalid(() => serializeBackup([row()], value));
    invalid(() => serializeBackup([row({ createdAt: value })], AT));
    invalid(() => parseBackup(JSON.stringify(archive([row({ updatedAt: value })]))));
  }
  const rollback = row({ createdAt: "2099-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" });
  const parsed = parseBackup(serializeBackup([rollback], AT));
  assert.deepEqual(parsed.records[0], rollback);
  const prepared = await prepareRestore(parsed);
  assert.deepEqual(planRestore(prepared, [], noIdNeeded).additions[0], { ...rollback, restoreKey: prepared[0].restoreKey });
  const extended = "+010000-01-01T00:00:00.000Z";
  assert.equal(parseBackup(serializeBackup([row({ createdAt: extended })], extended)).records[0].createdAt, extended);
});

test("duplicate archive IDs are rejected; up to 2000 distinct records are accepted", () => {
  invalid(() => serializeBackup([row(), row({ body: "Autre contenu" })], AT), /dupliqués/);
  invalid(() => parseBackup(JSON.stringify(archive([row(), row()]))), /dupliqués/);
  const records = Array.from({ length: MAX_BACKUP_RECORDS }, (_, index) => row({ id: "text-" + index, body: "" }));
  assert.equal(parseBackup(serializeBackup(records, AT)).records.length, MAX_BACKUP_RECORDS);
  invalid(() => serializeBackup([...records, row({ id: "extra" })], AT), /2 000/);
  invalid(() => parseBackup(JSON.stringify(archive([...records, row({ id: "extra" })]))), /2 000/);
});

test("titles use UTF-16 lengths and source names preserve their exact allowed boundary", () => {
  assert.equal(parseBackup(serializeBackup([row({ title: "🛰".repeat(80), sourceName: "x".repeat(1024) })], AT)).records[0].title.length, 160);
  invalid(() => serializeBackup([row({ title: "🛰".repeat(81) })], AT), /titre/i);
  assert.equal(parseBackup(serializeBackup([row({ id: "x".repeat(128) })], AT)).records[0].id.length, 128);
});

test("body size is bounded by UTF-8 bytes, including multibyte and lone-surrogate text", () => {
  for (const body of ["a".repeat(MIB), "é".repeat(MIB / 2), "🛰".repeat(MIB / 4)]) {
    assert.equal(Buffer.byteLength(body, "utf8"), MIB);
    assert.equal(parseBackup(serializeBackup([row({ body })], AT)).records[0].body, body);
    invalid(() => serializeBackup([row({ body: body + "a" })], AT), /1 Mio/);
    invalid(() => parseBackup(JSON.stringify(archive([row({ body: body + "a" })]))), /1 Mio/);
  }
  const lone = "\ud800".repeat(Math.floor(MIB / 3));
  assert.ok(Buffer.byteLength(lone, "utf8") <= MIB);
  assert.equal(parseBackup(serializeBackup([row({ body: lone })], AT)).records[0].body, lone);
  invalid(() => serializeBackup([row({ body: lone + "\ud800" })], AT), /1 Mio/);
});

test("32 MiB is an inclusive total bound on serialized JSON, not only raw bodies", () => {
  const full = "x".repeat(MIB);
  const records = Array.from({ length: 32 }, (_, index) => row({ id: "limit-" + index, body: index < 31 ? full : "" }));
  const headroom = MAX_BACKUP_BYTES - Buffer.byteLength(serializeBackup(records, AT), "utf8");
  assert.ok(headroom > 0 && headroom < MIB);
  records[31].body = "x".repeat(headroom);
  const exact = serializeBackup(records, AT);
  assert.equal(Buffer.byteLength(exact, "utf8"), MAX_BACKUP_BYTES);
  assert.equal(parseBackup(exact).records[31].body.length, headroom);
  invalid(() => parseBackup(exact + " "), /32 Mio/);
  records[31].body += "x";
  invalid(() => serializeBackup(records, AT), /32 Mio/);
});

test("oversize parsing stops before JSON.parse, including multibyte input", () => {
  invalid(() => parseBackup("{".repeat(MAX_BACKUP_BYTES + 1)), /32 Mio/);
  invalid(() => parseBackup("é".repeat(MAX_BACKUP_BYTES / 2 + 1)), /32 Mio/);
});

test("serialization accounts for JSON escaping and aborts before inspecting later records", () => {
  const escaped = "\0".repeat(MIB);
  const records = Array.from({ length: 6 }, (_, index) => row({ id: "escape-" + index, body: escaped }));
  let visited = false;
  const later = row({ id: "later" });
  Object.defineProperty(later, "body", {
    enumerable: true,
    get() { visited = true; throw new Error("Oversize archive was not stopped progressively"); },
  });
  invalid(() => serializeBackup([...records, later], AT), /32 Mio/);
  assert.equal(visited, false);
});

test("prepareRestore hashes canonical record metadata and ignores export date and input key order", async () => {
  const record = row({ sourceName: "source.txt" });
  const reordered = Object.fromEntries(Object.entries(record).reverse());
  const first = await prepareRestore(archive([record], AT));
  const second = await prepareRestore(archive([reordered], LATER));
  const expected = createHash("sha256").update(JSON.stringify(record), "utf8").digest("hex");
  assert.equal(first[0].restoreKey, expected);
  assert.equal(second[0].restoreKey, expected);
  assert.deepEqual(second[0].record, record);
  const changed = await prepareRestore(archive([row({ ...record, revision: record.revision + 1 })]));
  assert.notEqual(changed[0].restoreKey, expected);
  await assert.rejects(prepareRestore({ ...archive(), version: 2 }), { name: "BackupValidationError" });
});

test("free IDs retain their revision, dates, source and literal text without calling the factory", async () => {
  const original = row({ sourceName: "a.txt", body: "<b>littéral</b>", revision: 12 });
  const prepared = await prepareRestore(archive([original]));
  const plan = planRestore(prepared, [{ id: "unrelated", restoreKey: undefined }], noIdNeeded);
  assert.deepEqual(plan, { additions: [{ ...original, restoreKey: prepared[0].restoreKey }], skipped: 0 });
});

test("strictly identical occupied records are skipped, including when local internals differ", async () => {
  const original = row();
  const prepared = await prepareRestore(archive([original]));
  assert.deepEqual(planRestore(prepared, [{ ...original, privateState: true }], noIdNeeded), { additions: [], skipped: 1 });
  const changedDate = { ...original, updatedAt: LATER };
  assert.equal(planRestore(prepared, [changedDate], () => "new-date").additions.length, 1);
  assert.equal(planRestore(prepared, [{ ...original, sourceName: "" }], () => "new-source").additions.length, 1);
});

test("conflicts produce a separate suffixed copy with revision 1 and original timestamps", async () => {
  const original = row({ title: "x".repeat(148) + "🛰" + "x".repeat(10), sourceName: "original.txt", updatedAt: "2020-01-01T00:00:00.000Z" });
  assert.equal(original.title.length, 160);
  const prepared = await prepareRestore(archive([original]));
  const existing = row({ title: "Local actuel", body: "À conserver." });
  const plan = planRestore(prepared, [existing], () => "restored-id");
  assert.equal(plan.skipped, 0);
  assert.equal(plan.additions.length, 1);
  const added = plan.additions[0];
  assert.equal(added.id, "restored-id");
  assert.equal(added.title, "x".repeat(148) + " — restauré");
  assert.ok(added.title.length <= 160);
  assert.equal(added.revision, 1);
  assert.equal(added.createdAt, original.createdAt);
  assert.equal(added.updatedAt, original.updatedAt);
  assert.equal(added.sourceName, original.sourceName);
  assert.equal(added.body, original.body);
  assert.equal(added.restoreKey, prepared[0].restoreKey);
  assert.equal(existing.body, "À conserver.");
});

test("a repeated import is skipped after an imported conflict copy has been edited", async () => {
  const prepared = await prepareRestore(archive([row({ body: "Texte importé" })]));
  const local = row({ body: "Texte local" });
  const first = planRestore(prepared, [local], () => "copy-1");
  const edited = { ...first.additions[0], title: "Modifié", body: "Édition ultérieure", revision: 6, updatedAt: LATER };
  assert.deepEqual(planRestore(prepared, [local, edited], noIdNeeded), { additions: [], skipped: 1 });
  // Unrelated IDs need only the index projection retained by the IDB cursor.
  assert.deepEqual(planRestore(prepared, [{ id: edited.id, restoreKey: edited.restoreKey }], noIdNeeded), { additions: [], skipped: 1 });
});

test("a repeated import is skipped after a free-ID import is edited and keeps its restore key", async () => {
  const prepared = await prepareRestore(archive());
  const first = planRestore(prepared, [], noIdNeeded);
  const edited = { ...first.additions[0], body: "Édition locale", revision: 8 };
  assert.deepEqual(planRestore(prepared, [edited], noIdNeeded), { additions: [], skipped: 1 });
});

test("different IDs with identical bodies are not merged", async () => {
  const records = [row({ id: "a" }), row({ id: "b" })];
  const prepared = await prepareRestore(archive(records));
  assert.notEqual(prepared[0].restoreKey, prepared[1].restoreKey);
  const all = planRestore(prepared, [], noIdNeeded);
  assert.deepEqual(all.additions.map((record) => record.id), ["a", "b"]);
  const second = planRestore(prepared, [all.additions[0]], noIdNeeded);
  assert.equal(second.skipped, 1);
  assert.deepEqual(second.additions.map((record) => record.id), ["b"]);
});

test("factory results cannot steal occupied IDs, incoming IDs, or previously allocated IDs", async () => {
  const prepared = await prepareRestore(archive([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })]));
  const existing = [row({ id: "a", body: "local a" }), row({ id: "c", body: "local c" }), { id: "occupied" }];
  const values = ["a", "b", "occupied", "invalid id", "new-1", "new-1", "new-2"];
  let calls = 0;
  const plan = planRestore(prepared, existing, () => values[calls++]);
  assert.deepEqual(plan.additions.map((record) => record.id), ["new-1", "b", "new-2"]);
  assert.equal(calls, 7);
  assert.equal(new Set(plan.additions.map((record) => record.id)).size, 3);
});

test("unresolved factory collisions stop after eight attempts with no mutation", async () => {
  const prepared = deepFreeze(await prepareRestore(archive()));
  const existing = deepFreeze([row({ body: "Local" })]);
  const beforePrepared = JSON.stringify(prepared);
  const beforeExisting = JSON.stringify(existing);
  let calls = 0;
  invalid(() => planRestore(prepared, existing, () => { calls += 1; return "text-1"; }), /8 essais/);
  assert.equal(calls, 8);
  assert.equal(JSON.stringify(prepared), beforePrepared);
  assert.equal(JSON.stringify(existing), beforeExisting);
  invalid(() => planRestore(prepared, existing, () => { throw new Error("private failure"); }), /création/);
});

test("prepared input and existing ID ambiguities are rejected instead of overwriting", async () => {
  const prepared = await prepareRestore(archive());
  invalid(() => planRestore([...prepared, ...prepared], [], noIdNeeded), /dupliquées/);
  invalid(() => planRestore([{ ...prepared[0], restoreKey: "bad" }], [], noIdNeeded), /identité/);
  invalid(() => planRestore([{ ...prepared[0], unexpected: true }], [], noIdNeeded), /champ/);
  invalid(() => planRestore(prepared, [{ id: "a" }, { id: "a" }], noIdNeeded), /dupliqués/);
  invalid(() => planRestore(prepared, [], null));
});

test("serialization, preparation and planning leave deeply frozen inputs unchanged", async () => {
  const source = deepFreeze(archive([row(), row({ id: "second", kind: "document", sourceName: "source.txt" })]));
  const before = JSON.stringify(source);
  serializeBackup(source.records, source.exportedAt);
  const prepared = deepFreeze(await prepareRestore(source));
  const preparedBefore = JSON.stringify(prepared);
  const existing = deepFreeze([row({ body: "Texte local à conserver" }), { id: "unrelated", restoreKey: "b".repeat(64) }]);
  const existingBefore = JSON.stringify(existing);
  const plan = planRestore(prepared, existing, () => "fresh");
  assert.equal(plan.additions.length, 2);
  assert.equal(JSON.stringify(source), before);
  assert.equal(JSON.stringify(prepared), preparedBefore);
  assert.equal(JSON.stringify(existing), existingBefore);
  plan.additions[0].body = "Modification du résultat";
  assert.equal(prepared[0].record.body, source.records[0].body);
  assert.equal(existing[0].body, "Texte local à conserver");
});

test("an identical pre-existing row is not annotated; a later edit allows an archived conflict copy", async () => {
  const local = deepFreeze(row({ body: "Version commune" }));
  const prepared = await prepareRestore(archive([local]));
  assert.deepEqual(planRestore(prepared, [local], noIdNeeded), { additions: [], skipped: 1 });
  assert.equal(Object.hasOwn(local, "restoreKey"), false);

  const edited = deepFreeze({ ...local, body: "Nouvelle version locale", revision: 8, updatedAt: LATER });
  const result = planRestore(prepared, [edited], () => "archive-copy");
  assert.equal(result.skipped, 0);
  assert.equal(result.additions.length, 1);
  assert.equal(result.additions[0].id, "archive-copy");
  assert.equal(result.additions[0].body, "Version commune");
  assert.equal(result.additions[0].restoreKey, prepared[0].restoreKey);
  assert.equal(edited.body, "Nouvelle version locale");
  assert.equal(Object.hasOwn(edited, "restoreKey"), false);
});


test("restored title truncation preserves complete graphemes and every source field", async () => {
  for (const [prefixLength, sequence] of [[148, "e\u0301"], [147, "👨‍👩‍👧‍👦"], [147, "🇫🇷"]]) {
    const prefix = "x".repeat(prefixLength);
    const title = (prefix + sequence).padEnd(160, "z");
    const original = row({ title, sourceName: "original.md", body: "Corps 🧭 exact.\n" });
    const prepared = await prepareRestore(archive([original]));
    const plan = planRestore(prepared, [row({ body: "Version locale" })], () => "grapheme-copy");
    assert.equal(plan.additions[0].title, prefix + " — restauré");
    assert.equal(plan.additions[0].body, original.body);
    assert.equal(plan.additions[0].sourceName, original.sourceName);
    assert.equal(plan.additions[0].restoreKey, prepared[0].restoreKey);
  }
});

test("restored titles keep Unicode pairs when Intl Segmenter is unavailable", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
  Object.defineProperty(Intl, "Segmenter", { configurable: true, value: undefined });
  try {
    const original = row({ title: "x".repeat(148) + "😀" + "z".repeat(10) });
    const prepared = await prepareRestore(archive([original]));
    const plan = planRestore(prepared, [row({ body: "Version locale" })], () => "fallback-copy");
    assert.equal(plan.additions[0].title, "x".repeat(148) + " — restauré");
  } finally {
    if (descriptor) Object.defineProperty(Intl, "Segmenter", descriptor);
    else Reflect.deleteProperty(Intl, "Segmenter");
  }
});
