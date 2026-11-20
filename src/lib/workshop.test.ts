import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import {
  consumeWorkshopDraft, isMissionRunning, isMissionTerminal, parseWorkshopDetail, parseWorkshopList,
  requestWorkshop, safePreviewUrl, saveWorkshopDraft, parseWorkshopArtifact, requestWorkshopArtifact, workshopPreviewDocument,
  WORKSHOP_ARCHIVE_LIMIT, WORKSHOP_PREVIEW_LIMIT,
} from './workshop';

const transport = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: transport } }));

const task = {
  id: '00000000-0000-4000-8000-000000000012', key: 'build', title: 'Construire',
  state: 'verified_done', provider: 'codex', attempt: 1, outputSha: 'a'.repeat(40), evidenceCount: 2,
};
const mission = {
  id: '00000000-0000-4000-8000-000000000011', projectId: 'website', title: 'Un site de restaurant',
  state: 'verified_done', createdAt: '2026-11-12T12:00:00Z', updatedAt: '2026-11-12T12:00:00Z',
  finishedAt: '2026-11-12T12:00:00Z', totalTasks: 1, verifiedTasks: 1,
  usage: { tokens: 100, costMicros: 500 }, tasks: [task],
};
beforeEach(() => { transport.invoke.mockReset(); sessionStorage.clear(); });
afterEach(() => vi.unstubAllGlobals());

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const archiveBytes = new Uint8Array([80, 75, 5, 6, ...Array(18).fill(0)]);
const artifact = () => ({
  missionId: mission.id, commitSha: task.outputSha,
  archive: { fileName: 'restaurant.zip', mediaType: 'application/zip', base64: Buffer.from(archiveBytes).toString('base64'), bytes: archiveBytes.length, sha256: hash(archiveBytes) },
  preview: { fileName: 'index.html', mediaType: 'text/html', content: '<h1>Création réelle</h1>', bytes: Buffer.byteLength('<h1>Création réelle</h1>'), sha256: hash('<h1>Création réelle</h1>') },
});
const artifactIdentity = { missionId: mission.id, commitSha: task.outputSha };

describe('verified workshop artifacts', () => {
  beforeEach(() => { vi.stubGlobal('crypto', webcrypto); });
  it('verifies exact archive and UTF-8 preview bytes against their digests', async () => {
    const result = await parseWorkshopArtifact(artifact(), artifactIdentity);
    expect(result.archive.data).toEqual(archiveBytes);
    expect(result.preview?.content).toBe('<h1>Création réelle</h1>');
  });
  it('accepts a source archive without promising an HTML preview', async () => {
    const sourceOnly = { ...artifact(), preview: undefined };
    expect((await parseWorkshopArtifact(sourceOnly, artifactIdentity)).preview).toBeUndefined();
  });
  it('refuses a result bound to another mission or commit', async () => {
    await expect(parseWorkshopArtifact({ ...artifact(), missionId: '00000000-0000-4000-8000-000000000099' }, artifactIdentity)).rejects.toThrow(/invalide/);
    await expect(parseWorkshopArtifact({ ...artifact(), commitSha: 'b'.repeat(40) }, artifactIdentity)).rejects.toThrow(/invalide/);
  });
  it('refuses altered content before exposing a download or preview', async () => {
    const badArchive = artifact(); badArchive.archive.sha256 = '0'.repeat(64);
    await expect(parseWorkshopArtifact(badArchive, artifactIdentity)).rejects.toThrow(/empreinte/);
    const badPreview = artifact(); badPreview.preview.content = badPreview.preview.content.replace('réelle', 'fausse');
    await expect(parseWorkshopArtifact(badPreview, artifactIdentity)).rejects.toThrow();
  });
  it('enforces transport byte bounds, canonical base64 and safe filenames', async () => {
    for (const patch of [
      { bytes: WORKSHOP_ARCHIVE_LIMIT + 1 }, { bytes: archiveBytes.length - 1 },
      { base64: '<script>' }, { fileName: '../secret.zip' }, { mediaType: 'text/html' },
    ]) await expect(parseWorkshopArtifact({ ...artifact(), archive: { ...artifact().archive, ...patch } }, artifactIdentity)).rejects.toThrow(/invalide/);
    for (const patch of [
      { bytes: WORKSHOP_PREVIEW_LIMIT + 1 }, { bytes: 5 }, { fileName: '/index.html' }, { mediaType: 'image/svg+xml' },
    ]) await expect(parseWorkshopArtifact({ ...artifact(), preview: { ...artifact().preview, ...patch } }, artifactIdentity)).rejects.toThrow(/invalide/);
  });
  it('sends only the mission identity and requires verified implementation evidence', async () => {
    transport.invoke.mockResolvedValue({ data: { ok: true, artifact: artifact() }, error: null });
    const complete = { ...parseWorkshopDetail(mission), tasks: [{ ...parseWorkshopDetail(mission).tasks[0], key: 'implementation' }] };
    await expect(requestWorkshopArtifact(complete)).resolves.toMatchObject(artifactIdentity);
    expect(transport.invoke.mock.calls[0][1].body).toEqual({ action: 'artifact', missionId: mission.id });
    transport.invoke.mockClear();
    await expect(requestWorkshopArtifact({ ...complete, state: 'active' })).rejects.toThrow(/invalide/);
    await expect(requestWorkshopArtifact(parseWorkshopDetail(mission))).rejects.toThrow(/invalide/);
    expect(transport.invoke).not.toHaveBeenCalled();
  });
  it('discards an aborted artifact without retaining its content', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(parseWorkshopArtifact(artifact(), artifactIdentity, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('places a restrictive policy before every untrusted HTML token', () => {
    const content = '<script>parent.document.body.innerHTML="bad"</script>';
    const preview = workshopPreviewDocument(content);
    expect(preview.indexOf('Content-Security-Policy')).toBeLessThan(preview.indexOf(content));
    expect(preview).toContain("connect-src 'none'");
    expect(preview).toContain("frame-src 'none'");
    expect(preview).toContain("form-action 'none'");
    expect(preview).toContain("base-uri 'none'");
  });
});

describe('workshop response boundary', () => {
  it('accepts verified evidence with a safe HTTPS preview', () => {
    expect(parseWorkshopDetail({ ...mission, previewUrl: 'https://preview.example/site' })).toMatchObject({
      state: 'verified_done', verifiedTasks: 1, previewUrl: 'https://preview.example/site',
    });
  });
  it('rejects a claimed success without all tasks verified', () => {
    expect(() => parseWorkshopDetail({ ...mission, verifiedTasks: 0 })).toThrow(/invalide/);
    expect(() => parseWorkshopDetail({ ...mission, tasks: [{ ...task, state: 'running' }] })).toThrow(/invalide/);
    expect(() => parseWorkshopDetail({ ...mission, totalTasks: 0, verifiedTasks: 0, tasks: [] })).toThrow(/invalide/);
  });
  it('rejects duplicated task identifiers and impossible counters', () => {
    expect(() => parseWorkshopDetail({ ...mission, totalTasks: 2, verifiedTasks: 2, tasks: [task, task] })).toThrow(/invalide/);
    expect(() => parseWorkshopDetail({ ...mission, usage: { tokens: -1, costMicros: 0 } })).toThrow(/invalide/);
    expect(() => parseWorkshopDetail({ ...mission, tasks: [{ ...task, outputSha: '<script>' }] })).toThrow(/invalide/);
  });
  it('rejects unsafe preview destinations', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'http://example.test', 'https://user:secret@example.test']) {
      expect(() => safePreviewUrl(url)).toThrow(/invalide/);
    }
    expect(safePreviewUrl(undefined)).toBeUndefined();
  });
  it('validates availability and project limits before admitting the form', () => {
    expect(parseWorkshopList({ projects: [{ id: 'website', name: 'Site', ready: false, maxParallel: 2 }], missions: [] }).projects[0].ready).toBe(false);
    expect(() => parseWorkshopList({ projects: [{ id: 'website', name: 'Site', ready: 'yes', maxParallel: 2 }], missions: [] })).toThrow();
    expect(() => parseWorkshopList({ projects: [{ id: 'website', name: 'Site', ready: true, maxParallel: 0 }], missions: [] })).toThrow();
  });
  it('passes an abort signal and stable idempotency key to the authenticated edge function', async () => {
    transport.invoke.mockResolvedValue({ data: { ok: true, mission }, error: null });
    const controller = new AbortController();
    const input = { action: 'start' as const, projectId: 'website', prompt: 'Un site restaurant complet', requestId: '00000000-0000-4000-8000-000000000050' };
    await expect(requestWorkshop(input, controller.signal)).resolves.toMatchObject({ id: mission.id });
    expect(transport.invoke).toHaveBeenCalledWith('chef-workshop', { body: input, signal: controller.signal, timeout: 15000 });
    controller.abort();
    await expect(requestWorkshop(input, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('does not surface raw provider errors or accept an unsuccessful envelope', async () => {
    transport.invoke.mockResolvedValueOnce({ error: new Error('secret-provider-key'), data: null });
    await expect(requestWorkshop({ action: 'list' })).rejects.toThrow(/momentanément/);
    transport.invoke.mockResolvedValueOnce({ error: null, data: { ok: false, projects: [], missions: [] } });
    await expect(requestWorkshop({ action: 'list' })).rejects.toThrow(/invalide/);
  });
  it('keeps a requested stop polling until cancellation is confirmed', () => {
    expect(isMissionRunning('cancelling')).toBe(true);
    expect(isMissionTerminal('cancelling')).toBe(false);
    expect(isMissionTerminal('cancelled')).toBe(true);
    expect(isMissionRunning('human_required')).toBe(false);
  });
});

describe('workshop draft handoff', () => {
  it('preserves a signed-in draft for its owner and consumes it once', () => {
    saveWorkshopDraft('Mon projet de restaurant', 'alice', 1000);
    expect(consumeWorkshopDraft('alice', 2000)).toBe('Mon projet de restaurant');
    expect(consumeWorkshopDraft('alice', 2001)).toBe('');
  });
  it('does not expose another account’s draft', () => {
    saveWorkshopDraft('Projet privé de Alice', 'alice', 1000);
    expect(consumeWorkshopDraft('bob', 2000)).toBe('');
    expect(consumeWorkshopDraft('alice', 2000)).toBe('');
  });
  it('allows a pending login handoff only within its short lifetime', () => {
    saveWorkshopDraft('Projet avant connexion', null, 1000);
    expect(consumeWorkshopDraft('alice', 2000)).toBe('Projet avant connexion');
    saveWorkshopDraft('Projet trop ancien', null, 1000);
    expect(consumeWorkshopDraft('alice', 1000 + 21 * 60_000)).toBe('');
    saveWorkshopDraft('Date future invalide', null, 3000);
    expect(consumeWorkshopDraft('alice', 2000)).toBe('');
  });
});
