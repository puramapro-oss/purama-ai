import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestIaoRoutines, RoutineClientError, type RoutineInput } from './iao-routines-client';

const fixture = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: fixture } }));

const OWNER = '84000000-0000-4000-8000-000000000001';
const OTHER = '84000000-0000-4000-8000-000000000002';
const ID = '94000000-0000-4000-8000-000000000001';
const OCCURRENCE = '94000000-0000-4000-8000-000000000003';
const at = '2026-11-28T09:00:00.000Z';
const config = (): RoutineInput => ({ name: 'Matin', instruction: 'Présente les résultats et les blocages.', enabled: true,
  schedule: { kind: 'daily', time: '08:30', timezone: 'Europe/Paris' }, channels: ['in_app'], deliveryMode: 'parallel',
  agentTypes: [], length: 'standard', quietHours: null, pausedUntil: null, onlyIfNew: true, maxCallMinutes: 2, monthlyCallMinutes: 30 });
const routine = (extra = {}) => ({ id: ID, userId: OWNER, revision: 1, config: config(), createdAt: at, updatedAt: at, lastOccurrenceAt: null, ...extra });
const listing = (extra = {}) => ({ ok: true, routines: [routine()], history: [], commands: [],
  capabilities: { routines: true, calls: false, verifiedPhone: null, phoneBlockedReason: 'Numéro à vérifier',
    voiceCommands: 'confirmation_required', email: true, push: true, agents: [{ type: 'email', name: 'Courrier' }] }, ...extra });
const auth = () => ({ ownerId: OWNER, accessToken: 'synthetic-session-token', current: () => true });

beforeEach(() => { fixture.invoke.mockReset(); fixture.invoke.mockResolvedValue({ data: listing(), error: null }); });

describe('routine API client boundaries', () => {
  it('binds the explicit session token and never sends a browser-selected owner', async () => {
    const data = await requestIaoRoutines('list', {}, auth());
    expect(data.routines[0].userId).toBe(OWNER);
    expect(fixture.invoke).toHaveBeenCalledWith('iao-routines', {
      body: { action: 'list' }, headers: { Authorization: 'Bearer synthetic-session-token' }, signal: undefined, timeout: 12_000,
    });
  });

  it('does not send a retained callback from an expired session', async () => {
    await expect(requestIaoRoutines('list', {}, { ...auth(), current: () => false })).rejects.toThrow('session a changé');
    expect(fixture.invoke).not.toHaveBeenCalled();
  });

  it('rejects a late response after the session changes', async () => {
    let current = true;
    fixture.invoke.mockImplementation(async () => { current = false; return { data: listing(), error: null }; });
    await expect(requestIaoRoutines('list', {}, { ...auth(), current: () => current })).rejects.toThrow('session a changé');
  });

  it('rejects another account row without rendering it', async () => {
    fixture.invoke.mockResolvedValue({ data: listing({ routines: [routine({ userId: OTHER })] }), error: null });
    await expect(requestIaoRoutines('list', {}, auth())).rejects.toBeInstanceOf(RoutineClientError);
  });

  it.each([
    { routines: [routine(), routine()] },
    { history: [{ id: OCCURRENCE, routineId: ID, scheduledAt: at, status: 'completed', report: null, deliveries: [{ channel: 'call', status: 'heard' }] }] },
    { capabilities: { ...listing().capabilities, calls: 'yes' } },
    { routines: [routine({ lastOccurrenceAt: 'not-a-date' })] },
    { commands: [{ id: OCCURRENCE, occurrenceId: ID, instruction: 'Fais quelque chose', status: 'executed', createdAt: at }] },
  ])('rejects malformed or contradictory public data %#', async patch => {
    fixture.invoke.mockResolvedValue({ data: listing(patch), error: null });
    await expect(requestIaoRoutines('list', {}, auth())).rejects.toThrow('Réponse du service non confirmée');
  });

  it('does not convert a null reply or a false success into confirmed delivery', async () => {
    for (const data of [null, { ok: false }, { occurrence: { id: OCCURRENCE } }]) {
      fixture.invoke.mockResolvedValue({ data, error: null });
      await expect(requestIaoRoutines('run-now', { id: ID, expectedRevision: 1, requestId: OCCURRENCE }, auth())).rejects.toThrow();
    }
  });

  it('validates a saved revision and the actual saved config before announcing success', async () => {
    fixture.invoke.mockResolvedValue({ data: { ok: true, routine: routine({ revision: 2 }) }, error: null });
    await expect(requestIaoRoutines('save', { id: ID, expectedRevision: 1, config: config() }, auth())).resolves.toMatchObject({ routine: { revision: 2 } });
    fixture.invoke.mockResolvedValue({ data: { ok: true, routine: routine({ revision: 1 }) }, error: null });
    await expect(requestIaoRoutines('save', { id: ID, expectedRevision: 1, config: config() }, auth())).resolves.toMatchObject({ routine: { revision: 1 } });
    fixture.invoke.mockResolvedValue({ data: { ok: true, routine: routine({ revision: 2, config: { ...config(), channels: ['call'] } }) }, error: null });
    await expect(requestIaoRoutines('save', { id: ID, expectedRevision: 1, config: config() }, auth())).rejects.toThrow();
  });

  it('requires revision one for creation and refuses older or skipped versions', async () => {
    fixture.invoke.mockResolvedValue({ data: { ok: true, routine: routine({ revision: 1 }) }, error: null });
    await expect(requestIaoRoutines('save', { id: ID, expectedRevision: 0, config: config() }, auth())).resolves.toMatchObject({ routine: { revision: 1 } });
    await expect(requestIaoRoutines('save', { id: ID, expectedRevision: 2, config: config() }, auth())).rejects.toThrow();
    fixture.invoke.mockResolvedValue({ data: { ok: true, routine: routine({ revision: 2 }) }, error: null });
    await expect(requestIaoRoutines('save', { id: ID, expectedRevision: 0, config: config() }, auth())).rejects.toThrow();
  });

  it('accepts an unchanged pause revision only when the requested settings already apply', async () => {
    const configPaused = { ...config(), enabled: false };
    fixture.invoke.mockResolvedValue({ data: { ok: true, routine: routine({ config: configPaused }) }, error: null });
    await expect(requestIaoRoutines('pause', { id: ID, expectedRevision: 1, enabled: false, pausedUntil: null }, auth()))
      .resolves.toMatchObject({ routine: { revision: 1, config: configPaused } });
    await expect(requestIaoRoutines('pause', { id: ID, expectedRevision: 1, enabled: false, pausedUntil: at }, auth())).rejects.toThrow();
    fixture.invoke.mockResolvedValue({ data: { ok: true, routine: routine({ config: { ...config(), name: 'Autre contenu' } }) }, error: null });
    await expect(requestIaoRoutines('save', { id: ID, expectedRevision: 1, config: config() }, auth())).rejects.toThrow();
  });

  it('refuses a pause receipt that leaves the routine enabled', async () => {
    fixture.invoke.mockResolvedValue({ data: { ok: true, routine: routine({ revision: 2 }) }, error: null });
    await expect(requestIaoRoutines('pause', { id: ID, expectedRevision: 1, enabled: false, pausedUntil: null }, auth())).rejects.toThrow();
  });

  it('preserves an accepted call as accepted, without inventing that a person heard it', async () => {
    fixture.invoke.mockResolvedValue({ data: { ok: true, occurrence: { id: OCCURRENCE, routineId: ID, scheduledAt: at, status: 'processing',
      deliveries: [{ channel: 'call', status: 'accepted' }] } }, error: null });
    const result = await requestIaoRoutines('run-now', { id: ID, expectedRevision: 1, requestId: OCCURRENCE }, auth());
    expect(result.occurrence.deliveries).toEqual([{ channel: 'call', status: 'accepted' }]);
  });

  it('does not retry an ambiguous mutation or expose a provider diagnostic', async () => {
    fixture.invoke.mockResolvedValue({ data: null, error: { message: 'private provider diagnostic', context: { status: 502 } } });
    await expect(requestIaoRoutines('run-now', { id: ID, expectedRevision: 1, requestId: OCCURRENCE }, auth()))
      .rejects.toMatchObject({ uncertain: true, message: 'Résultat non confirmé. Actualisez l’historique avant de réessayer.' });
    expect(fixture.invoke).toHaveBeenCalledTimes(1);
  });

  it('classifies a conflict as rejected and asks for current state', async () => {
    fixture.invoke.mockResolvedValue({ data: null, error: { context: { status: 409 } } });
    await expect(requestIaoRoutines('pause', { id: ID, expectedRevision: 1, pausedUntil: null, enabled: false }, auth()))
      .rejects.toMatchObject({ uncertain: false, message: expect.stringContaining('réglages ont changé') });
  });

  it('rejects unrecognized input fields before transmission', async () => {
    await expect(requestIaoRoutines('list', { userId: OTHER } as never, auth())).rejects.toThrow('demande de routine est invalide');
    expect(fixture.invoke).not.toHaveBeenCalled();
  });

  it('rejects duplicate or unsorted occurrence previews', async () => {
    fixture.invoke.mockResolvedValue({ data: { ok: true, occurrences: [at, at] }, error: null });
    await expect(requestIaoRoutines('preview', { config: config() }, auth())).rejects.toThrow();
  });

  it('reports only cancellation of waiting sends, not cancellation of an accepted call', async () => {
    fixture.invoke.mockResolvedValue({ data: { ok: true, cancelled: true, occurrenceId: OCCURRENCE }, error: null });
    const result = await requestIaoRoutines('cancel', { occurrenceId: OCCURRENCE }, auth());
    expect(result.warning).toContain('Un appel déjà transmis peut continuer');
  });
});
