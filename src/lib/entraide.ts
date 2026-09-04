// Adapter ENTRAIDE pour purama-ai — implémente MOULE-ENTRAIDE.md §1 contre le schéma purama_ai.
// Appelle la lib pure @purama/entraide (décision pure) avec les données réelles DB.

import { supabase } from '@/integrations/supabase/client';
import type {
  MutualAidProfile,
  WeekDay,
  MissionCollective,
  CreateMissionCollectiveInput,
} from '@purama/entraide';

// ─── Mise en relation (profil) ───

export async function getMutualAidProfile(userId: string): Promise<MutualAidProfile | null> {
  const { data: profil, error: profilError } = await supabase
    .from('entraide_profils')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (profilError) throw profilError;
  if (!profil) return null;

  const { data: blockedUsers, error: blockedError } = await supabase
    .from('entraide_blocages')
    .select('blocked_id')
    .eq('blocker_id', userId);

  if (blockedError) throw blockedError;

  return {
    userId,
    skillsOffered: profil.skills_offered ?? [],
    skillsNeeded: profil.skills_needed ?? [],
    availabilityDays: (profil.availability_days ?? []) as WeekDay[],
    radiusKm: profil.radius_km,
    location:
      profil.location_lat !== null && profil.location_lng !== null
        ? { lat: profil.location_lat, lng: profil.location_lng }
        : null,
    blockedUserIds: blockedUsers?.map((b) => b.blocked_id) ?? [],
  };
}

export async function getBlockedUserIds(userId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('entraide_blocages')
    .select('blocked_id')
    .eq('blocker_id', userId);

  if (error) throw error;
  return data?.map((b) => b.blocked_id) ?? [];
}

// ─── Missions collectives ───

export async function persistMissionCollective(mission: MissionCollective): Promise<void> {
  const { error: missionError } = await supabase
    .from('missions_collectives')
    .upsert(
      {
        id: mission.id,
        organizer_id: mission.participantIds[0],
        title: '',
        description: '',
        min_participants: mission.minParticipants,
        max_participants: mission.maxParticipants,
        status: mission.status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    );

  if (missionError) throw missionError;

  const { error: deleteError } = await supabase
    .from('missions_collectives_participants')
    .delete()
    .eq('mission_id', mission.id);

  if (deleteError) throw deleteError;

  if (mission.participantIds.length > 0) {
    const { error: insertError } = await supabase.from('missions_collectives_participants').insert(
      mission.participantIds.map((userId) => ({
        mission_id: mission.id,
        user_id: userId,
      }))
    );

    if (insertError) throw insertError;
  }
}

export async function loadMissionCollective(missionId: string): Promise<MissionCollective | null> {
  const { data: missionData, error: missionError } = await supabase
    .from('missions_collectives')
    .select('*')
    .eq('id', missionId)
    .maybeSingle();

  if (missionError) throw missionError;
  if (!missionData) return null;

  const { data: participants, error: participantsError } = await supabase
    .from('missions_collectives_participants')
    .select('user_id')
    .eq('mission_id', missionId)
    .order('joined_at', { ascending: true });

  if (participantsError) throw participantsError;

  return {
    id: missionData.id,
    minParticipants: missionData.min_participants,
    maxParticipants: missionData.max_participants,
    participantIds: participants?.map((p) => p.user_id) ?? [],
    status: missionData.status as MissionCollective['status'],
  };
}

export async function createMissionInDB(
  input: CreateMissionCollectiveInput & { title: string; description: string }
): Promise<void> {
  const { error } = await supabase.from('missions_collectives').insert({
    id: input.id,
    organizer_id: input.organizerId,
    title: input.title,
    description: input.description,
    min_participants: input.minParticipants,
    max_participants: input.maxParticipants ?? null,
    status: 'ouverte',
  });

  if (error) throw error;

  const { error: participantError } = await supabase
    .from('missions_collectives_participants')
    .insert({
      mission_id: input.id,
      user_id: input.organizerId,
    });

  if (participantError) throw participantError;
}

// ─── Contact sécurisé ───

export async function getContactRequestsSentToday(userId: string): Promise<number> {
  const today = new Date().toISOString().split('T')[0];
  const { count, error } = await supabase
    .from('entraide_contact_requests')
    .select('*', { count: 'exact', head: true })
    .eq('requester_id', userId)
    .gte('created_at', `${today}T00:00:00Z`)
    .lt('created_at', `${today}T23:59:59Z`);

  if (error) throw error;
  return count ?? 0;
}

export async function getPendingRequestToRecipient(
  requesterId: string,
  recipientId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('entraide_contact_requests')
    .select('id')
    .eq('requester_id', requesterId)
    .eq('recipient_id', recipientId)
    .eq('status', 'pending')
    .maybeSingle();

  if (error) throw error;
  return data !== null;
}

export async function getLastDeclineOrExpiry(
  requesterId: string,
  recipientId: string
): Promise<Date | null> {
  const { data, error } = await supabase
    .from('entraide_contact_requests')
    .select('responded_at')
    .eq('requester_id', requesterId)
    .eq('recipient_id', recipientId)
    .in('status', ['declined', 'expired'])
    .order('responded_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data?.responded_at ? new Date(data.responded_at) : null;
}

export async function resolveContactChannel(requestId: string): Promise<string> {
  const { data, error } = await supabase
    .from('entraide_contact_requests')
    .select('status')
    .eq('id', requestId)
    .eq('status', 'accepted')
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('Contact request not found or not accepted');

  return `/dashboard/entraide?contact_request=${encodeURIComponent(requestId)}`;
}

export async function reportProfile(
  reporterId: string,
  targetId: string,
  reason: string
): Promise<void> {
  const { error } = await supabase.from('entraide_signalements').insert({
    reporter_id: reporterId,
    target_id: targetId,
    reason,
  });

  if (error) throw error;
}
