/**
 * Real qualification of the production UI -> Auth -> workshop proxy -> CHEF.
 * No routes, responses, authentication or model work are mocked by this script.
 * Read-only resumption of one already verified mission. It never creates or cancels a mission.
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
import { open, mkdir, writeFile, copyFile } from 'node:fs/promises';
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
const runTag = 'authenticated-resume-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const receipt = {
  kind: 'workshop-authenticated-artifact-resume', version: 1,
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
  let browser, config, page, display;
  const expectedMission = '94c0d8cb-936d-4963-8afc-b74ef975e38f';
  const expectedCommit = '027a291700e691209d05aea712f41446701db57b';
  receipt.readOnlyResume = true;
  receipt.missionId = expectedMission;
  receipt.commitSha = expectedCommit;
  receipt.phases = [];
  const step = phase => { receipt.stage = phase; receipt.phases.push(phase); };
  try {
    step('configuration');
    config = await readPrivateConfig();
    const { chromium } = await import('@playwright/test');
    step('browser_start');
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}), timeout: 15000 });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, serviceWorkers: 'block' });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', () => receipt.javascriptErrorCount++);
    step('ui_login');
    await page.goto(config.origin + '/dashboard/atelier', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.getByLabel('Email', { exact: true }).fill(config.accounts.owner.email);
    await page.getByLabel('Mot de passe', { exact: true }).fill(config.accounts.owner.password);
    await declineOptionalCookies(page);
    const authUrl = new URL(config.supabaseUrl + '/auth/v1/token');
    const login = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === 'POST' && url.origin === authUrl.origin && url.pathname === authUrl.pathname && url.searchParams.get('grant_type') === 'password';
    });
    void login.catch(() => undefined);
    await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
    const loginResponse = await login;
    requireCondition(loginResponse.status() === 200, 'LOGIN_FAILED');
    const auth = await loginResponse.json();
    requireCondition(typeof auth.access_token === 'string' && auth.access_token.length > 50, 'AUTH_INVALID');
    await page.waitForURL(url => url.origin === config.origin && url.pathname === '/dashboard/atelier');
    receipt.checks.login = { outcome: 'PASS' };
    async function proxy(action) {
      const response = await fetch(config.proxyUrl, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', apikey: config.anonKey, Authorization: 'Bearer ' + auth.access_token },
        body: JSON.stringify({ action, missionId: expectedMission }), signal: AbortSignal.timeout(15000) });
      return { status: response.status, data: await boundedJson(response) };
    }
    step('mission_status_api');
    const status = await proxy('status');
    requireCondition(status.status === 200 && status.data?.mission?.id === expectedMission && status.data.mission.state === 'verified_done', 'MISSION_NOT_VERIFIED');
    const mission = status.data.mission;
    receipt.checks.mission = { outcome: 'PASS', tasks: mission.tasks.length, state: 'verified_done' };
    step('artifact_api');
    const exported = await proxy('artifact');
    const artifact = exported.data?.artifact;
    requireCondition(exported.status === 200 && artifact?.missionId === expectedMission && artifact.commitSha === expectedCommit, 'ARTIFACT_API_INVALID');
    receipt.checks.artifactApi = { outcome: 'PASS', bytes: artifact.archive?.bytes, sha256: artifact.archive?.sha256, hasPreview: artifact.preview?.mediaType === 'text/html' };
    step('mission_ui');
    await page.getByLabel('Projet', { exact: true }).waitFor({ state: 'visible' });
    const missionButton = page.getByRole('button').filter({ hasText: mission.title });
    if (await missionButton.count()) await missionButton.first().click();
    display = page.getByTestId('workshop-result');
    await display.waitFor({ state: 'visible' });
    receipt.checks.resultVisible = { outcome: 'PASS' };
    receipt.browserCapabilities = await page.evaluate(() => ({ secureContext: isSecureContext, subtleCrypto: Boolean(crypto?.subtle), objectUrl: typeof URL.createObjectURL === 'function' }));
    step('artifact_ui_request');
    await declineOptionalCookies(page);
    const downloadResponse = page.waitForResponse(response => {
      if (response.url() !== config.proxyUrl || response.request().method() !== 'POST') return false;
      try { return response.request().postDataJSON()?.action === 'artifact'; } catch { return false; }
    });
    void downloadResponse.catch(() => undefined);
    await display.getByRole('button', { name: 'Accéder aux fichiers', exact: true }).click();
    const apiResponse = await downloadResponse;
    const uiResult = await apiResponse.json();
    receipt.checks.artifactUiResponse = {
      status: apiResponse.status(), ok: uiResult?.ok === true, missionMatches: uiResult?.artifact?.missionId === expectedMission,
      commitMatches: uiResult?.artifact?.commitSha === expectedCommit,
      archiveBytes: uiResult?.artifact?.archive?.bytes, archiveBase64Length: uiResult?.artifact?.archive?.base64?.length,
      previewBytes: uiResult?.artifact?.preview?.bytes, previewCharacters: uiResult?.artifact?.preview?.content?.length,
    };
    step('download_link');
    const link = display.getByRole('link', { name: 'Télécharger les sources ZIP', exact: true });
    await link.waitFor({ state: 'visible' });
    const downloadEvent = page.waitForEvent('download');
    void downloadEvent.catch(() => undefined);
    step('download_click');
    await link.click();
    step('download_event');
    const download = await downloadEvent;
    step('download_bytes');
    const digest = await hashDownload(download);
    requireCondition(digest.bytes === artifact.archive.bytes && digest.sha256 === artifact.archive.sha256, 'DOWNLOAD_INTEGRITY_FAILED');
    receipt.checks.sourceDownload = { outcome: 'PASS', ...digest };
    step('preview_open');
    await display.getByRole('button', { name: 'Afficher l’aperçu', exact: true }).click();
    const iframe = page.locator('iframe[title="Aperçu isolé de votre création"]');
    requireCondition(await iframe.getAttribute('sandbox') === 'allow-scripts', 'PREVIEW_SANDBOX_INVALID');
    const preview = page.frameLocator('iframe[title="Aperçu isolé de votre création"]');
    const counter = preview.locator(config.artifact.counterSelector);
    await counter.waitFor({ state: 'visible' });
    step('preview_counter');
    const initialText = (await counter.innerText()).trim();
    requireCondition(/^\d{1,9}$/.test(initialText), 'COUNTER_INVALID');
    const initial = Number(initialText);
    const button = preview.getByRole('button', { name: config.artifact.buttonName, exact: true });
    for (let i=0;i<3;i++) await button.click();
    await button.press('Enter');
    const frame = await (await iframe.elementHandle()).contentFrame();
    await frame.waitForFunction(({selector,expected}) => document.querySelector(selector)?.textContent?.trim() === String(expected), {selector:config.artifact.counterSelector,expected:initial+4},{timeout:15000});
    requireCondition(await frame.evaluate(() => { try { void parent.document.body; return false; } catch { return true; } }), 'PREVIEW_PARENT_NOT_ISOLATED');
    receipt.checks.preview = { outcome:'PASS',initial,final:initial+4,parentAccessBlocked:true };
    step('desktop_capture');
    const desktop=runTag+'-desktop.png'; await display.screenshot({path:join(outputDirectory,desktop)}); receipt.captures.push(desktop);
    step('mobile');
    await page.setViewportSize({width:390,height:844});
    await display.getByRole('button',{name:'Mobile',exact:true}).click();
    const frameWidth=Math.round((await iframe.boundingBox()).width);
    await frame.waitForFunction(expected=>Math.abs(innerWidth-expected)<=1,frameWidth,{timeout:10000});
    await frame.evaluate(async()=>{
      await document.fonts.ready;
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    });
    requireCondition(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'WORKSHOP_OVERFLOW');
    requireCondition(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'PREVIEW_OVERFLOW');
    await button.click();
    await frame.waitForFunction(({selector,expected})=>document.querySelector(selector)?.textContent?.trim()===String(expected),{selector:config.artifact.counterSelector,expected:initial+5},{timeout:10000});
    await iframe.scrollIntoViewIfNeeded();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const mobile=runTag+'-mobile-preview.png'; await iframe.screenshot({path:join(outputDirectory,mobile)}); receipt.captures.push(mobile);
    const viewport=runTag+'-mobile-viewport.png'; await page.screenshot({path:join(outputDirectory,viewport),fullPage:false}); receipt.captures.push(viewport);
    receipt.checks.mobile={outcome:'PASS',viewport:390,iframeWidth:frameWidth,mobileClickIncrement:1,final:initial+5,captureMethod:'stable viewport and iframe, no element-height resize'};
    step('preserve_ui_archive');
    const archiveName=runTag+'-download.zip';
    await copyFile(await download.path(),join(outputDirectory,archiveName),constants.COPYFILE_EXCL);
    receipt.archiveFile=archiveName;
    requireCondition(receipt.javascriptErrorCount===0,'BROWSER_ERROR');
    receipt.outcome='PASS';step('complete');
  } catch(error) {
    receipt.outcome='FAIL';
    receipt.failureCode=error instanceof QualificationError?error.code:'STEP_FAILED';
    receipt.failureType=['TimeoutError','TypeError','Error'].includes(error?.name)?error.name:'Other';
    if(page) {
      try {
        const alerts=await page.getByRole('alert').allTextContents();
        receipt.alertCategories=['empreinte','invalide','momentanément','injoignable','HTTPS','accessible','indisponible'].filter(label=>alerts.some(text=>text.includes(label)));
        receipt.selectors={result:await page.getByTestId('workshop-result').count(),files:await page.getByRole('button',{name:'Accéder aux fichiers',exact:true}).count(),retry:await page.getByRole('button',{name:'Réessayer les fichiers',exact:true}).count(),download:await page.getByRole('link',{name:'Télécharger les sources ZIP',exact:true}).count(),preview:await page.locator('iframe[title="Aperçu isolé de votre création"]').count()};
        if(display && await display.isVisible()) { const screenshot=runTag+'-result.png';await display.screenshot({path:join(outputDirectory,screenshot),timeout:5000});receipt.captures.push(screenshot); }
      } catch { receipt.uiDiagnosticUnavailable=true; }
    }
  } finally {
    if(browser) await browser.close().catch(()=>undefined);
    receipt.finishedAt=new Date().toISOString();
    receipt.durationMs=Date.parse(receipt.finishedAt)-Date.parse(receipt.startedAt);
    const file=runTag+'.json';
    await mkdir(outputDirectory,{recursive:true});
    await writeFile(join(outputDirectory,file),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o644});
    receipt.receiptFile=file;
    process.stdout.write(JSON.stringify(receipt)+'\n');
    process.exitCode=receipt.outcome==='PASS'?0:1;
  }
}
await main();
