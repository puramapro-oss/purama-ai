import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const findings = [];
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/,
  /\bre_[A-Za-z0-9]{20,}\b/,
  /\btvly-[A-Za-z0-9_-]{20,}\b/,
];
const assignment = /^[ \t]*[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)[ \t]*=[ \t]*["']?([^\s"']{20,})["']?[ \t]*$/gm;

for (const file of tracked) {
  if (file === "package-lock.json" || file.startsWith(".gitnexus/")) continue;
  let source;
  try { source = readFileSync(file, "utf8"); } catch { continue; }
  if (secretPatterns.some((pattern) => pattern.test(source))) findings.push(`${file}: recognized secret format`);
  for (const match of source.matchAll(assignment)) {
    const value = match[1];
    if (!value.startsWith("$") && !value.startsWith("<") && !/^(?:REPLACE|example|your-|xxx)/i.test(value)) {
      findings.push(`${file}: literal secret-like assignment`);
    }
  }
}

for (const file of tracked.filter((name) => name.startsWith(".github/workflows/") && /\.ya?ml$/.test(name))) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)) {
    if (!/@[0-9a-f]{40}$/.test(match[1])) findings.push(`${file}: action is not pinned to a full commit SHA`);
  }
  if (/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash)\b/.test(source)) findings.push(`${file}: pipe-to-shell installer`);
  if (/\bpull_request_target\s*:/.test(source)) findings.push(`${file}: pull_request_target requires manual review`);
}

if (findings.length) {
  console.error("Repository security policy failed:\n" + [...new Set(findings)].map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}
console.log("Repository security policy passed.");
