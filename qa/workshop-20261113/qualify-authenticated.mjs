/**
 * Real qualification of the production UI -> Auth -> workshop proxy -> CHEF.
 * No routes, responses, authentication or model work are mocked by this script.
 * It creates at most one mission. Run only on the dedicated qualification project.
 *
 * WORKSHOP_QUAL_CONFIG points to a private JSON file (regular file, mode 0600):
 * { origin, supabaseUrl, proxyUrl, anonKey,
 *   accounts: { owner: {email,password}, other: {email,password} },
 *   projectId, prompt, timeoutMs?: 600000,
 *   artifact?: { counterSelector?: '#counter', buttonName?: 'Ajouter une unité' } }
 * PLAYWRIGHT_EXECUTABLE_PATH may select an existing local Chromium installation.
 * Credentials and browser storage are never written into receipts or traces.
 */
import { constants, createReadStream } from 'node:fs';
import { open, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Playwright debug logging may include filled fields. Disable it before importing Playwright.
delete process.env.DEBUG;
delete process.env.PWDEBUG;
delete process.env.DEBUG_COLORS;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const MISSION_STATES = new Set(['planning', 'active', 'paused', 'human_required', 'external_required', 'verified_done', 'failed', 'cancelled', 'cancelling']);
const MAX_ARCHIVE = 4 * 1024 * 1024;
const MAX_RESPONSE = 7 * 1024 * 1024;
const outputDirectory = dirname(fileURLToPath(import.meta.url));
const runTag = 'authenticated-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const receipt = {
  kind: 'workshop-authenticated-qualification', version: 1,
  startedAt: new Date().toISOString(), outcome: 'NON_TESTE', stage: 'configuration',
  fixtureResponsesUsed: false, missionSubmission: 'not_sent', startRequestCount: 0,
  observedStates: [], checks: {}, captures: [], javascriptErrorCount: 0,
  monetaryCost: { status: 'unknown', micros: null },
};
class QualificationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireCondition(condition, code) { if (!condition) throw new QualificationError(code); }
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function requiredText(value, maximum) {
  requireCondition(typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0'), 'CONFIG_INVALID');
  return value;
}
function configuredUrl(value, originOnly = false) {
  const url = new URL(requiredText(value, 2048));
  requireCondition((url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    && !url.username && !url.password && !url.search && !url.hash
    && (!originOnly || url.pathname === '/'), 'CONFIG_URL_INVALID');
  return originOnly ? url.origin : url.href.replace(/\/$/, '');
}
async function readPrivateConfig() {
  const configPath = requiredText(process.env.WORKSHOP_QUAL_CONFIG, 4096);
  const handle = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    requireCondition(stat.isFile() && stat.size > 0 && stat.size <= 32768 && (stat.mode & 0o077) === 0
      && (typeof process.getuid !== 'function' || stat.uid === process.getuid()), 'CONFIG_NOT_PRIVATE');
    const buffer = Buffer.alloc(32769);
    let total = 0;
    while (total < buffer.length) {
      const part = await handle.read(buffer, total, buffer.length - total, null);
      if (part.bytesRead === 0) break;
      total += part.bytesRead;
    }
    requireCondition(total <= 32768, 'CONFIG_TOO_LARGE');
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total)));
    requireCondition(record(input) && record(input.accounts), 'CONFIG_INVALID');
    const accounts = {};
    for (const role of ['owner', 'other']) {
      requireCondition(record(input.accounts[role]), 'CONFIG_INVALID');
      accounts[role] = { email: requiredText(input.accounts[role].email, 320), password: requiredText(input.accounts[role].password, 1024) };
    }
    requireCondition(accounts.owner.email.toLowerCase() !== accounts.other.email.toLowerCase(), 'ACCOUNTS_MUST_DIFFER');
    const projectId = requiredText(input.projectId, 48);
    requireCondition(/^[a-z0-9][a-z0-9-]{0,47}$/.test(projectId), 'CONFIG_PROJECT_INVALID');
    const prompt = requiredText(input.prompt, 6000);
    requireCondition(prompt.trim().length >= 20, 'CONFIG_PROMPT_INVALID');
    const timeoutMs = input.timeoutMs ?? 600000;
    requireCondition(Number.isSafeInteger(timeoutMs) && timeoutMs >= 60000 && timeoutMs <= 600000, 'CONFIG_TIMEOUT_INVALID');
    const counterSelector = input.artifact?.counterSelector ?? '#counter';
    requireCondition(typeof counterSelector === 'string' && /^#[a-z][a-z0-9_-]{0,63}$/i.test(counterSelector), 'CONFIG_SELECTOR_INVALID');
    return {
      origin: configuredUrl(input.origin, true), supabaseUrl: configuredUrl(input.supabaseUrl), proxyUrl: configuredUrl(input.proxyUrl),
      anonKey: requiredText(input.anonKey, 20000), accounts, projectId, prompt, timeoutMs,
      artifact: { counterSelector, buttonName: requiredText(input.artifact?.buttonName ?? 'Ajouter une unité', 120) },
    };
  } finally { await handle.close(); }
}
async function boundedJson(response, maximum = MAX_RESPONSE) {
  requireCondition(response.body, 'PROXY_RESPONSE_EMPTY');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      requireCondition(bytes <= maximum, 'PROXY_RESPONSE_TOO_LARGE');
      chunks.push(result.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
async function hashDownload(download) {
  const path = await download.path();
  requireCondition(path, 'DOWNLOAD_MISSING');
  const stream = createReadStream(path);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      requireCondition(bytes <= MAX_ARCHIVE, 'DOWNLOAD_TOO_LARGE');
      hash.update(chunk);
    }
    return { bytes, sha256: hash.digest('hex') };
  } finally { stream.destroy(); }
}
async function declineOptionalCookies(page) {
  const dialog = page.getByRole('dialog', { name: 'Gestion des cookies', exact: true });
  if (await dialog.isVisible()) {
    await dialog.getByRole('button', { name: 'Refuser tout', exact: true }).click({ timeout: 10000 });
    receipt.optionalCookieRefusals = (receipt.optionalCookieRefusals ?? 0) + 1;
  }
}
async function main() {
  let browser, config, owner, other, lastMission;
  let workDeadline = Date.now() + 585000;
  let stage = 'configuration';
  const step = value => { stage = value; receipt.stage = value; };
  const remaining = () => {
    const time = workDeadline - Date.now();
    requireCondition(time > 0, 'QUALIFICATION_TIMEOUT');
    return time;
  };
  const timeout = () => Math.min(15000, remaining());
  async function proxy(token, body, cleanup = false) {
    const response = await fetch(config.proxyUrl, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', apikey: config.anonKey, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(cleanup ? 5000 : timeout()),
    });
    const data = await boundedJson(response);
    return { status: response.status, data };
  }
  async function signIn(role) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', () => { receipt.javascriptErrorCount++; });
    await page.goto(config.origin + '/dashboard/atelier', { waitUntil: 'domcontentloaded', timeout: timeout() });
    await page.getByLabel('Email', { exact: true }).fill(config.accounts[role].email, { timeout: timeout() });
    await page.getByLabel('Mot de passe', { exact: true }).fill(config.accounts[role].password, { timeout: timeout() });
    await declineOptionalCookies(page);
    const authUrl = new URL(config.supabaseUrl + '/auth/v1/token');
    const authResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === 'POST' && url.origin === authUrl.origin && url.pathname === authUrl.pathname
        && url.searchParams.get('grant_type') === 'password';
    }, { timeout: timeout() });
    void authResponse.catch(() => undefined);
    await page.getByRole('button', { name: 'Se connecter', exact: true }).click({ timeout: timeout() });
    const response = await authResponse;
    requireCondition(response.status() === 200, 'AUTH_LOGIN_FAILED');
    const result = await response.json();
    requireCondition(record(result) && typeof result.access_token === 'string' && result.access_token.length >= 50 && result.access_token.length <= 20000
      && UUID.test(result.user?.id ?? ''), 'AUTH_RESPONSE_INVALID');
    await page.waitForURL(url => url.origin === config.origin && url.pathname === '/dashboard/atelier', { timeout: timeout() });
    await page.getByLabel('Projet', { exact: true }).waitFor({ state: 'visible', timeout: timeout() });
    return { context, page, token: result.access_token, userId: result.user.id };
  }
  function observeMission(value) {
    requireCondition(record(value) && UUID.test(value.id ?? '') && MISSION_STATES.has(value.state), 'MISSION_RESPONSE_INVALID');
    if (receipt.missionId) requireCondition(value.id === receipt.missionId, 'MISSION_ID_CHANGED');
    receipt.missionId = value.id;
    lastMission = value;
    if (receipt.observedStates.at(-1) !== value.state) receipt.observedStates.push(value.state);
  }
  async function assertDenied(token, action, expectedStatuses, label) {
    const response = await proxy(token, { action, missionId: receipt.missionId });
    requireCondition(expectedStatuses.includes(response.status) && record(response.data) && response.data.ok === false
      && !Object.hasOwn(response.data, 'mission') && !Object.hasOwn(response.data, 'artifact'), 'ACCESS_ISOLATION_FAILED');
    receipt.checks[label] = { outcome: 'PASS', status: response.status };
  }
  try {
    config = await readPrivateConfig();
    workDeadline = Date.parse(receipt.startedAt) + config.timeoutMs - 15000;
    const { chromium } = await import('@playwright/test');
    step('browser_start');
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}), timeout: timeout() });
    step('owner_ui_login'); owner = await signIn('owner');
    step('other_ui_login'); other = await signIn('other');
    requireCondition(owner.userId !== other.userId, 'AUTH_PRINCIPALS_NOT_DISTINCT');
    receipt.checks.realLogin = { outcome: 'PASS', accounts: 2, distinctPrincipals: true };
    const secondAccountList = await proxy(other.token, { action: 'list' });
    requireCondition(secondAccountList.status === 200 && secondAccountList.data?.ok === true, 'SECOND_ACCOUNT_SESSION_INVALID');

    step('submit_single_mission');
    owner.page.on('request', request => {
      if (request.url() !== config.proxyUrl || request.method() !== 'POST') return;
      try {
        const body = request.postDataJSON();
        if (body?.action !== 'start') return;
        receipt.startRequestCount++;
        receipt.missionSubmission = 'sent';
        if (UUID.test(body.requestId ?? '')) receipt.requestId = body.requestId;
      } catch { /* No raw request data is retained. */ }
    });
    await owner.page.getByLabel('Projet', { exact: true }).selectOption(config.projectId, { timeout: timeout() });
    await owner.page.getByLabel('Que voulez-vous créer ou améliorer ?', { exact: true }).fill(config.prompt, { timeout: timeout() });
    const started = owner.page.waitForResponse(response => {
      if (response.url() !== config.proxyUrl || response.request().method() !== 'POST') return false;
      try { return response.request().postDataJSON()?.action === 'start'; } catch { return false; }
    }, { timeout: timeout() });
    void started.catch(() => undefined);
    await owner.page.getByRole('button', { name: 'Lancer la création', exact: true }).click({ timeout: timeout() });
    const startResponse = await started;
    requireCondition(startResponse.status() === 200, 'MISSION_SUBMISSION_FAILED');
    const startResult = await startResponse.json();
    requireCondition(startResult?.ok === true && receipt.startRequestCount === 1, 'MISSION_SUBMISSION_UNCONFIRMED');
    observeMission(startResult.mission);
    receipt.missionSubmission = 'confirmed';

    step('access_isolation');
    await assertDenied(other.token, 'status', [403, 404], 'otherAccountStatus');
    await assertDenied(null, 'status', [401], 'anonymousStatus');
    step('real_mission_execution');
    while (lastMission.state !== 'verified_done') {
      requireCondition(['planning', 'active'].includes(lastMission.state), 'MISSION_NOT_VERIFIED_' + lastMission.state.toUpperCase().replace(/[^A-Z_]/g, '').slice(0,40));
      await delay(Math.min(3000, remaining()));
      const result = await proxy(owner.token, { action: 'status', missionId: receipt.missionId });
      requireCondition(result.status === 200 && result.data?.ok === true, 'MISSION_STATUS_FAILED');
      observeMission(result.data.mission);
    }
    requireCondition(Array.isArray(lastMission.tasks) && lastMission.tasks.length > 0
      && lastMission.tasks.every(task => task.state === 'verified_done' && SHA.test(task.outputSha ?? ''))
      && new Set(lastMission.tasks.map(task => task.outputSha.toLowerCase())).size === 1, 'MISSION_EVIDENCE_INCOMPLETE');
    const implementation = lastMission.tasks.find(task => task.key === 'implementation');
    requireCondition(implementation, 'IMPLEMENTATION_EVIDENCE_MISSING');
    receipt.commitSha = implementation.outputSha.toLowerCase();
    receipt.tasksVerified = lastMission.tasks.length;
    if (Number.isSafeInteger(lastMission.usage?.tokens) && lastMission.usage.tokens >= 0) receipt.tokensReported = lastMission.usage.tokens;
    receipt.checks.realMission = { outcome: 'PASS', state: 'verified_done' };
    await assertDenied(other.token, 'artifact', [403, 404], 'otherAccountArtifact');
    await assertDenied(null, 'artifact', [401], 'anonymousArtifact');

    step('verified_artifact');
    const result = await proxy(owner.token, { action: 'artifact', missionId: receipt.missionId });
    const artifact = result.data?.artifact;
    requireCondition(result.status === 200 && result.data?.ok === true && artifact?.missionId === receipt.missionId
      && artifact.commitSha === receipt.commitSha && artifact.archive?.mediaType === 'application/zip'
      && Number.isSafeInteger(artifact.archive.bytes) && artifact.archive.bytes > 0 && artifact.archive.bytes <= MAX_ARCHIVE
      && SHA256.test(artifact.archive.sha256 ?? ''), 'ARTIFACT_RESPONSE_INVALID');
    requireCondition(artifact.preview?.mediaType === 'text/html', 'PREVIEW_UNAVAILABLE');
    const display = owner.page.getByTestId('workshop-result');
    await display.waitFor({ state: 'visible', timeout: timeout() });
    await declineOptionalCookies(owner.page);
    await display.getByRole('button', { name: 'Accéder aux fichiers', exact: true }).click({ timeout: timeout() });
    const link = display.getByRole('link', { name: 'Télécharger les sources ZIP', exact: true });
    await link.waitFor({ state: 'visible', timeout: timeout() });
    const received = owner.page.waitForEvent('download', { timeout: timeout() });
    void received.catch(() => undefined);
    await link.click({ timeout: timeout() });
    const download = await received;
    requireCondition(download.suggestedFilename() === artifact.archive.fileName, 'DOWNLOAD_NAME_MISMATCH');
    const digest = await hashDownload(download);
    requireCondition(digest.bytes === artifact.archive.bytes && digest.sha256 === artifact.archive.sha256.toLowerCase(), 'DOWNLOAD_INTEGRITY_FAILED');
    receipt.checks.sourceDownload = { outcome: 'PASS', ...digest, mediaType: 'application/zip' };
    await display.getByRole('button', { name: 'Afficher l’aperçu', exact: true }).click({ timeout: timeout() });
    const frameElement = owner.page.locator('iframe[title="Aperçu isolé de votre création"]');
    requireCondition(await frameElement.getAttribute('sandbox') === 'allow-scripts', 'PREVIEW_SANDBOX_INVALID');
    const preview = owner.page.frameLocator('iframe[title="Aperçu isolé de votre création"]');
    const counter = preview.locator(config.artifact.counterSelector);
    await counter.waitFor({ state: 'visible', timeout: timeout() });
    const initialText = (await counter.innerText()).trim();
    requireCondition(/^\d{1,9}$/.test(initialText), 'COUNTER_INITIAL_INVALID');
    const initial = Number(initialText);
    const button = preview.getByRole('button', { name: config.artifact.buttonName, exact: true });
    for (let i = 0; i < 3; i++) await button.click({ timeout: timeout() });
    await button.press('Enter', { timeout: timeout() });
    const frame = await (await frameElement.elementHandle()).contentFrame();
    requireCondition(frame, 'PREVIEW_FRAME_MISSING');
    await frame.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.textContent?.trim() === String(expected),
      { selector: config.artifact.counterSelector, expected: initial + 4 }, { timeout: timeout() });
    const parentBlocked = await frame.evaluate(() => { try { void window.parent.document.body; return false; } catch { return true; } });
    requireCondition(parentBlocked, 'PREVIEW_PARENT_NOT_ISOLATED');
    receipt.checks.previewInteraction = { outcome: 'PASS', clicks: 3, keyboardActivations: 1, initial, final: initial + 4, parentAccessBlocked: true };
    const desktopName = runTag + '-desktop.png';
    await display.screenshot({ path: join(outputDirectory, desktopName), timeout: timeout() });
    receipt.captures.push(desktopName);
    await owner.page.setViewportSize({ width: 390, height: 844 });
    await display.getByRole('button', { name: 'Mobile', exact: true }).click({ timeout: timeout() });
    requireCondition(await owner.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'WORKSHOP_MOBILE_OVERFLOW');
    requireCondition(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'CREATION_MOBILE_OVERFLOW');
    receipt.checks.mobile = { outcome: 'PASS', viewport: 390, outerOverflow: false, previewOverflow: false };
    const mobileName = runTag + '-mobile.png';
    await display.screenshot({ path: join(outputDirectory, mobileName), timeout: timeout() });
    receipt.captures.push(mobileName);
    requireCondition(receipt.javascriptErrorCount === 0, 'UNCAUGHT_BROWSER_ERROR');
    receipt.checks.browserErrors = { outcome: 'PASS', count: 0 };
    receipt.outcome = 'PASS';
    step('complete');
  } catch (error) {
    receipt.outcome = 'FAIL';
    receipt.stage = stage;
    receipt.failureCode = error instanceof QualificationError ? error.code : 'STEP_FAILED';
    // No error message/stack is retained: it may contain credentials, URLs, HTML or provider text.
  } finally {
    if (owner && receipt.missionId && lastMission && !['verified_done', 'failed', 'cancelled'].includes(lastMission.state)) {
      try {
        const stop = await proxy(owner.token, { action: 'cancel', missionId: receipt.missionId }, true);
        receipt.cleanup = { cancellationRequested: stop.status === 200, stopConfirmed: stop.data?.mission?.state === 'cancelled' };
      } catch { receipt.cleanup = { cancellationRequested: false, stopConfirmed: false }; }
    }
    if (browser) {
      let closeTimer;
      receipt.browserClosed = await Promise.race([
        browser.close().then(() => true, () => false),
        new Promise(resolve => { closeTimer = setTimeout(() => resolve(false), 5000); }),
      ]);
      clearTimeout(closeTimer);
      if (!receipt.browserClosed) { receipt.outcome = 'FAIL'; receipt.browserCleanupFailed = true; }
    }
    receipt.finishedAt = new Date().toISOString();
    receipt.durationMs = Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt);
    const name = runTag + '.json';
    try {
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(join(outputDirectory, name), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
      receipt.receiptFile = name;
    } catch { receipt.receiptWriteFailed = true; receipt.outcome = 'FAIL'; }
    const exitCode = receipt.outcome === 'PASS' ? 0 : 1;
    process.stdout.write(JSON.stringify(receipt) + '\n', () => {
      // This is a dedicated CLI invocation; do not remain alive on a broken driver connection.
      if (receipt.browserCleanupFailed) process.exit(exitCode);
    });
    process.exitCode = exitCode;
  }
}
await main();
