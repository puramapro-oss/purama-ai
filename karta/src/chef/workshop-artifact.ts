import { resolveTrustedGit } from "./trusted-git.js";
import { createHash } from "node:crypto";
import type { WorkshopProject } from "./workshop-config.js";
import { runChefProcess } from "./process.js";

export const WORKSHOP_ARCHIVE_MAX_BYTES = 4 * 1024 * 1024;
export const WORKSHOP_PREVIEW_MAX_BYTES = 200 * 1024;
const MAX_FILES = 256;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Paths come from trusted configuration, but Git trees are untrusted input. */
export function isWorkshopExportPath(path: string): boolean {
  // eslint-disable-next-line no-control-regex -- Reject control characters in archive filenames.
  if (!path || path.length > 1000 || path.startsWith("/") || path.includes("[") || /[\\:*?\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split("/").every(part => {
    const name = part.toLowerCase();
    return part !== "." && part !== ".." && part !== "" &&
      !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
      ![".git", ".hg", ".svn", ".ssh", ".aws", ".azure", ".codex", "node_modules", ".npmrc", ".pypirc", ".netrc"].includes(name) &&
      !/^\.env(?:\.|$)/.test(name) && !/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/.test(name) &&
      !/^(?:credentials?|secrets?|tokens?)(?:\.(?:json|ya?ml|toml|ini|conf)|$)/.test(name) &&
      !/^auth\.(?:json|ya?ml|toml|ini|conf)(?:\.|$)/.test(name) &&
      !/\.(?:pem|key|p12|pfx|jks|keystore|sqlite|sqlite3|db)$/.test(name);
  });
}

async function readGit(cwd: string, args: string[], maximum: number, signal?: AbortSignal, input?: string): Promise<Buffer> {
  const result = await runChefProcess({
    command: await resolveTrustedGit(cwd), args: ["--no-replace-objects", "--literal-pathspecs", "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false", ...args], cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1",
      GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    signal, input, timeoutMs: 10_000, maxOutputBytes: maximum,
    label: "Lecture artefact atelier", abortMessage: "Lecture annulée", timeoutMessage: "Lecture expirée",
  });
  // output is binary-preserving; successful read commands must have stdout only.
  if (result.exitCode !== 0 || result.stderr) throw new Error("Objet Git non disponible");
  return result.output;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
type Entry = { path: string; bytes: Buffer };

/** Deterministic, uncompressed ZIP: no executable attributes, paths or timestamps from the host. */
function archive(entries: Entry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const checksum = crc32(entry.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12); // 1980-01-01, stable across requests.
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(entry.bytes.length, 18);
    header.writeUInt32LE(entry.bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, entry.bytes);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(33, 14);
    directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(entry.bytes.length, 20);
    directory.writeUInt32LE(entry.bytes.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42); central.push(directory, name);
    offset += header.length + name.length + entry.bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  if (offset + directory.length + end.length > WORKSHOP_ARCHIVE_MAX_BYTES) throw new Error("Archive trop volumineuse");
  return Buffer.concat([...local, directory, end]);
}

/** Reads the admitted commit, never HEAD or mutable working-tree files. No Git archive attributes or filters run. */
export async function buildWorkshopArtifact(project: WorkshopProject, missionId: string, commitSha: string, signal?: AbortSignal) {
  if (!SHA.test(commitSha)) throw new Error("Révision artefact invalide");
  const roots = project.exportPaths ?? project.allowedPaths;
  if (!roots.length || roots.some(path => !isWorkshopExportPath(path))) throw new Error("Périmètre export invalide");
  const kind = await readGit(project.workdir, ["cat-file", "-t", commitSha], 100, signal);
  if (kind.toString("utf8").trim() !== "commit") throw new Error("Commit artefact absent");
  const treeBytes = await readGit(project.workdir, ["ls-tree", "-r", "-l", "-z", "--full-tree", commitSha, "--", ...roots], 512 * 1024, signal);
  const tree = new TextDecoder("utf-8", { fatal: true }).decode(treeBytes).split("\0").filter(Boolean);
  if (!tree.length || tree.length > MAX_FILES) throw new Error("Nombre de fichiers export invalide");
  const records = tree.map(row => {
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\s+(\d+)\t(.+)$/.exec(row);
    if (!match) throw new Error("Fichier export non régulier");
    const [, , sha, rawSize, path] = match;
    const size = Number(rawSize);
    if (!isWorkshopExportPath(path) || !roots.some(root => path === root || path.startsWith(root + "/")) ||
        !Number.isSafeInteger(size) || size < 0 || size > WORKSHOP_ARCHIVE_MAX_BYTES) throw new Error("Fichier export non admissible");
    return { sha, size, path };
  }).sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (new Set(records.map(record => record.path.normalize("NFC").toLowerCase())).size !== records.length ||
      records.reduce((total, record) => total + record.size, 0) > WORKSHOP_ARCHIVE_MAX_BYTES) throw new Error("Archive trop volumineuse");
  const entries: Entry[] = [];
  const blobs = await readGit(project.workdir, ["cat-file", "--batch"], WORKSHOP_ARCHIVE_MAX_BYTES + MAX_FILES * 128,
    signal, records.map(record => record.sha).join("\n") + "\n");
  let offset = 0;
  for (const record of records) {
    const end = blobs.indexOf(10, offset);
    if (end < offset || blobs.subarray(offset, end).toString("ascii") !== `${record.sha} blob ${record.size}`) throw new Error("Objet Git non confirmé");
    offset = end + 1;
    const bytes = blobs.subarray(offset, offset + record.size);
    offset += record.size;
    if (bytes.length !== record.size || blobs[offset++] !== 10) throw new Error("Objet Git non confirmé");
    entries.push({ path: record.path, bytes });
  }
  if (offset !== blobs.length) throw new Error("Flux Git non confirmé");
  const zip = archive(entries);
  let preview: { fileName: string; mediaType: "text/html"; content: string; sha256: string; bytes: number } | undefined;
  const html = project.previewEntry ? entries.find(entry => entry.path === project.previewEntry) : undefined;
  if (html && html.bytes.length > 0 && html.bytes.length <= WORKSHOP_PREVIEW_MAX_BYTES) {
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(html.bytes);
      // eslint-disable-next-line no-control-regex -- Binary/control data cannot be rendered as an HTML preview.
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) throw new Error("HTML non admissible");
      preview = { fileName: "preview.html", mediaType: "text/html", content, sha256: digest(html.bytes), bytes: html.bytes.length };
    } catch { /* A binary/non-UTF8 file is downloadable source, never rendered as HTML. */ }
  }
  return { missionId, commitSha,
    archive: { fileName: `${project.id}-${commitSha.slice(0, 12)}.zip`, mediaType: "application/zip" as const,
      base64: zip.toString("base64"), sha256: digest(zip), bytes: zip.length },
    ...(preview ? { preview } : {}),
  };
}
