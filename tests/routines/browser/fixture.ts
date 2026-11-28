import { calculateNextOccurrences } from '../../../karta/src/routines/schedule';
import type { Routine, RoutineInput } from '../../../karta/src/routines/contracts';

export const accounts = {
  A: '84000000-0000-4000-8000-000000000001',
  B: '84000000-0000-4000-8000-000000000002',
};
const at = '2026-11-28T06:00:00.000Z';
type Scenario = { seeded?: boolean; calls?: boolean; unavailable?: boolean; failList?: boolean; ambiguousRun?: boolean; commands?: boolean };
const scenario = (window as unknown as { __routineScenario?: Scenario }).__routineScenario ?? {};
export const initialOwner = accounts.A;
export const rows: Record<string, Routine[]> = { [accounts.A]: [], [accounts.B]: [] };
const histories: Record<string, Array<Record<string, unknown>>> = { [accounts.A]: [], [accounts.B]: [] };
const pendingCommands: Record<string, unknown[]> = { [accounts.A]: [], [accounts.B]: [] };
const requests: Array<{ action: string; body: Record<string, unknown>; owner: string }> = [];
const runIds = new Map<string, Record<string, unknown>>();
let failList = !!scenario.failList;
let ambiguousRun = !!scenario.ambiguousRun;
let holdNext: string | null = null;
let held: (() => void) | null = null;
let setOwner: (owner: string | null) => void = () => {};
const config = (name = 'Mon bilan du matin'): RoutineInput => ({
  name, instruction: 'Présente les travaux terminés, les blocages et les décisions en attente.', enabled: true,
  schedule: { kind: 'daily', time: '08:30', timezone: 'Europe/Paris' },
  channels: ['in_app'], deliveryMode: 'parallel', agentTypes: [], length: 'standard', quietHours: { start: '22:00', end: '08:00' },
  pausedUntil: null, onlyIfNew: true, maxCallMinutes: 2, monthlyCallMinutes: 30,
});
const routine = (owner: string, name: string): Routine => ({
  id: owner === accounts.A ? '94000000-0000-4000-8000-000000000001' : '94000000-0000-4000-8000-000000000002',
  userId: owner, revision: 1, config: config(name), createdAt: at, updatedAt: at, lastOccurrenceAt: null,
});
if (scenario.seeded) {
  rows[accounts.A].push(routine(accounts.A, 'Bilan privé A'));
  rows[accounts.B].push(routine(accounts.B, 'Bilan privé B'));
}
if (scenario.commands) pendingCommands[accounts.A].push({
  id: '94000000-0000-4000-8000-000000000008', occurrenceId: '94000000-0000-4000-8000-000000000009',
  instruction: 'Prépare le document pour mon projet.', status: 'pending_confirmation', createdAt: at,
});

export const fixture = {
  snapshot: () => ({ rows, histories, requests }),
  failList: (value: boolean) => { failList = value; },
  holdNext: (action: string) => { holdNext = action; },
  resolveHeld: () => { held?.(); held = null; },
  account: (name: 'A' | 'B' | null) => { setOwner(name ? accounts[name] : null); },
  bindOwner: (set: (owner: string | null) => void) => { setOwner = set; },
};
(window as unknown as { __routineFixture: typeof fixture }).__routineFixture = fixture;

export const supabase = { functions: { async invoke(_name: string, options: {
  body: Record<string, unknown>; headers: { Authorization: string }; signal: AbortSignal;
}) {
  const owner = options.headers.Authorization.replace('Bearer test-session-', '');
  const body = structuredClone(options.body);
  const action = String(body.action);
  requests.push({ action, body, owner });
  if (!rows[owner]) return { data: null, error: { context: { status: 401 } } };
  if (holdNext === action) {
    holdNext = null;
    // Deliberately non-cooperative fixture: tests require ignoring a late response after abort.
    await new Promise<void>(resolve => { held = resolve; });
  }
  const success = (data: Record<string, unknown>) => ({ data: { ok: true, ...data }, error: null });
  const failure = (status: number) => ({ data: null, error: { context: { status } } });
  if (action === 'list') {
    if (failList) return failure(503);
    return success({ routines: structuredClone(rows[owner]), history: structuredClone(histories[owner]), commands: pendingCommands[owner], capabilities: {
      routines: !scenario.unavailable, calls: !!scenario.calls, verifiedPhone: scenario.calls ? '+33 •••• 12 34' : null,
      phoneBlockedReason: scenario.calls ? null : 'Vérifiez un numéro et activez le service téléphonique.',
      voiceCommands: 'confirmation_required', email: true, push: true,
      agents: [{ type: 'email', name: 'Courrier' }, { type: 'compta', name: 'Comptabilité' }],
    } });
  }
  if (action === 'preview') return success({ occurrences: calculateNextOccurrences(body.config as RoutineInput, at, 3) });
  if (action === 'save') {
    const existing = rows[owner].find(row => row.id === body.id);
    if ((existing?.revision ?? 0) !== body.expectedRevision) return failure(409);
    const saved: Routine = { id: String(body.id), userId: owner, revision: Number(body.expectedRevision) + 1,
      config: body.config as RoutineInput, createdAt: existing?.createdAt ?? at, updatedAt: at, lastOccurrenceAt: existing?.lastOccurrenceAt ?? null };
    rows[owner] = [...rows[owner].filter(row => row.id !== body.id), saved];
    return success({ routine: structuredClone(saved) });
  }
  if (action === 'pause') {
    const row = rows[owner].find(row => row.id === body.id);
    if (!row || row.revision !== body.expectedRevision) return failure(409);
    row.revision++; row.config = { ...row.config, pausedUntil: body.pausedUntil as string | null,
      ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}) };
    return success({ routine: structuredClone(row) });
  }
  if (action === 'pause-all') {
    let updatedCount = 0;
    for (const row of rows[owner]) if (row.config.enabled) { row.config.enabled = false; row.revision++; updatedCount++; }
    return success({ updatedCount });
  }
  if (action === 'run-now') {
    const row = rows[owner].find(row => row.id === body.id);
    if (!row || row.revision !== body.expectedRevision || !row.config.enabled) return failure(409);
    const key = `${owner}:${body.requestId}`;
    let occurrence = runIds.get(key);
    if (!occurrence) {
      occurrence = { id: crypto.randomUUID(), routineId: row.id, scheduledAt: at, status: 'pending', report: null,
        deliveries: row.config.channels.map(channel => ({ channel, status: 'pending' })) };
      runIds.set(key, occurrence); histories[owner].unshift(occurrence);
    }
    if (ambiguousRun) { ambiguousRun = false; return failure(502); }
    return success({ occurrence });
  }
  if (action === 'cancel') {
    const item = histories[owner].find(row => row.id === body.occurrenceId);
    if (!item) return failure(404);
    item.status = 'cancelled';
    return success({ cancelled: true, occurrenceId: item.id });
  }
  return failure(400);
} } };
