// Compatibility adapter. All mission/contact commands go through the authenticated edge API.
import { supabase } from '@/integrations/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requestEntraide, EntraideHttpError } from './entraide-http';
import { joinMission, leaveMission } from '@purama/entraide';
import type { MutualAidProfile, WeekDay, MissionCollective, CreateMissionCollectiveInput } from '@purama/entraide';

interface ProfileRow {
  user_id: string; skills_offered: string[]; skills_needed: string[]; availability_days: WeekDay[];
  radius_km: number | null; location_lat: number | null; location_lng: number | null;
}
interface MissionRow {
  id: string; organizer_id: string; min_participants: number; max_participants: number | null;
  status: MissionCollective['status']; revision: number;
  missions_collectives_participants: { user_id: string; joined_at: string }[];
}
interface ContactRow {
  id: string; requester_id: string; recipient_id: string; status: string; created_at: string; responded_at: string | null;
}
interface Contacts { requests: ContactRow[]; blocked_user_ids: string[] }
const loadedRevisions = new Map<string, number>();

// The generated application types predate the existing 20260904 Entraide table.
// This narrow contract mirrors that migration, while retaining the same auth client.
type ReportRow = { id: string; reporter_id: string; target_id: string; reason: string; created_at: string };
type ReportDatabase = { purama_ai: {
  Tables: { entraide_signalements: { Row: ReportRow;
    Insert: Pick<ReportRow, 'reporter_id' | 'target_id' | 'reason'> & Partial<Pick<ReportRow, 'id' | 'created_at'>>;
    Update: Partial<ReportRow>; Relationships: [] } };
  Views: Record<string, never>; Functions: Record<string, never>;
  Enums: Record<string, never>; CompositeTypes: Record<string, never>;
} };

async function ownSession(expectedUser?: string) {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token || (expectedUser && data.session.user.id !== expectedUser)) {
    throw new Error('Connecte-toi avec le compte concerné pour continuer.');
  }
  return data.session;
}
function asMission(row: MissionRow): MissionCollective {
  return { id: row.id, minParticipants: row.min_participants, maxParticipants: row.max_participants,
    status: row.status, participantIds: row.missions_collectives_participants.map(p => p.user_id) };
}
function equalMission(a: MissionCollective, b: MissionCollective) {
  return a.id === b.id && a.minParticipants === b.minParticipants && a.maxParticipants === b.maxParticipants &&
    a.status === b.status && a.participantIds.length === b.participantIds.length &&
    new Set(a.participantIds).size === a.participantIds.length && a.participantIds.every(id => b.participantIds.includes(id));
}
async function contacts(expectedUser?: string): Promise<Contacts> {
  const session = await ownSession(expectedUser);
  return requestEntraide<Contacts>('entraide-contact', { token: session.access_token });
}

export async function getMutualAidProfile(userId: string): Promise<MutualAidProfile | null> {
  const session = await ownSession(userId);
  const { profil } = await requestEntraide<{ profil: ProfileRow | null }>('entraide-profil', { token: session.access_token });
  if (!profil) return null;
  return { userId, skillsOffered: profil.skills_offered, skillsNeeded: profil.skills_needed,
    availabilityDays: profil.availability_days, radiusKm: profil.radius_km,
    location: profil.location_lat !== null && profil.location_lng !== null ? { lat: profil.location_lat, lng: profil.location_lng } : null,
    blockedUserIds: await getBlockedUserIds(userId) };
}

export async function getBlockedUserIds(userId: string): Promise<string[]> {
  return (await contacts(userId)).blocked_user_ids;
}

/**
 * Compatibility for a pure mission transition after loadMissionCollective().
 * A snapshot can express one authorized transition only; it cannot overwrite the
 * organizer, metadata, other members or a newer revision. New callers should use
 * explicit edge commands directly, as the Entraide page does.
 */
export async function persistMissionCollective(mission: MissionCollective): Promise<void> {
  const session = await ownSession();
  const key = `${session.user.id}:${mission.id}`;
  const { mission: current } = await requestEntraide<{ mission: MissionRow }>(`entraide-missions/${mission.id}`, { token: session.access_token });
  if (loadedRevisions.get(key) !== current.revision) throw new Error('La mission a changé. Recharge-la avant de modifier son état.');
  const before = asMission(current);
  if (equalMission(before, mission)) return;
  let action: string | undefined;
  for (const [candidate, transition] of [['join', joinMission], ['leave', leaveMission]] as const) {
    const result = transition(before, session.user.id);
    if (result.ok && equalMission(result.mission, mission)) action = candidate;
  }
  if (!action && current.organizer_id === session.user.id) {
    const candidate = { en_cours: 'start', terminee: 'complete', annulee: 'cancel' }[mission.status as 'en_cours' | 'terminee' | 'annulee'];
    if (candidate && equalMission({ ...before, status: mission.status }, mission)) action = candidate;
  }
  if (!action) throw new Error('Cette modification doit utiliser une action explicite autorisée de la mission.');
  const result = await requestEntraide<{ mission: MissionRow }>(`entraide-missions/${mission.id}/${action}`, {
    token: session.access_token, method: 'POST', body: { expected_revision: current.revision },
  });
  loadedRevisions.set(key, result.mission.revision);
}

export async function loadMissionCollective(missionId: string): Promise<MissionCollective | null> {
  const session = await ownSession();
  const key = `${session.user.id}:${missionId}`;
  try {
    const { mission } = await requestEntraide<{ mission: MissionRow }>(`entraide-missions/${missionId}`, { token: session.access_token });
    loadedRevisions.set(key, mission.revision);
    return asMission(mission);
  } catch (error) {
    if (error instanceof EntraideHttpError && error.status === 404) { loadedRevisions.delete(key); return null; }
    throw error;
  }
}

export async function createMissionInDB(
  input: CreateMissionCollectiveInput & { title: string; description: string; visibility?: 'private' | 'public' },
): Promise<void> {
  const session = await ownSession(input.organizerId);
  const { mission } = await requestEntraide<{ mission: MissionRow }>('entraide-missions', {
    token: session.access_token, method: 'POST', body: {
      id: input.id, title: input.title, description: input.description, min_participants: input.minParticipants,
      max_participants: input.maxParticipants ?? null, visibility: input.visibility ?? 'private',
    },
  });
  loadedRevisions.set(`${session.user.id}:${mission.id}`, mission.revision);
}

// These helpers describe current server state. PostgreSQL remains the quota authority.
export async function getContactRequestsSentToday(userId: string): Promise<number> {
  const { requests } = await contacts(userId);
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const end = start.getTime() + 86_400_000;
  return requests.filter(r => r.requester_id === userId && Date.parse(r.created_at) >= start.getTime() && Date.parse(r.created_at) < end).length;
}
export async function getPendingRequestToRecipient(requesterId: string, recipientId: string): Promise<boolean> {
  const { requests } = await contacts(requesterId);
  return requests.some(r => r.requester_id === requesterId && r.recipient_id === recipientId && r.status === 'pending');
}
export async function getLastDeclineOrExpiry(requesterId: string, recipientId: string): Promise<Date | null> {
  const { requests } = await contacts(requesterId);
  const times = requests.filter(r => r.requester_id === requesterId && r.recipient_id === recipientId &&
    ['declined', 'expired'].includes(r.status) && r.responded_at).map(r => Date.parse(r.responded_at!));
  return times.length ? new Date(Math.max(...times)) : null;
}

/** Returns the existing contact review page; this is not a messaging channel. */
export async function resolveContactChannel(requestId: string): Promise<string> {
  const { requests } = await contacts();
  if (!requests.some(r => r.id === requestId && r.status === 'accepted')) throw new Error('Cet accord de contact n’est plus disponible.');
  return `/dashboard/entraide?contact_request=${encodeURIComponent(requestId)}`;
}
export async function reportProfile(reporterId: string, targetId: string, reason: string): Promise<void> {
  await ownSession(reporterId);
  if (!reason.trim() || reason.trim().length > 1000 || targetId === reporterId) throw new Error('Le motif du signalement est invalide.');
  const reports = (supabase as unknown as SupabaseClient<ReportDatabase>).schema('purama_ai');
  const { error } = await reports.from('entraide_signalements').insert({ reporter_id: reporterId, target_id: targetId, reason: reason.trim() });
  if (error) throw new Error('Le signalement n’a pas pu être confirmé. Réessaie plus tard.');
}
