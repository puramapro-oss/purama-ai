import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.91.0';
import type { EntraidePorts, Payload } from './entraide-http.ts';
import { computeMatchScore } from './vendor/entraide-matching.js';

// Edge reads validate every returned value at runtime. Keep the SDK schema
// explicit without borrowing the older browser-generated database snapshot.
export interface EntraideDatabase {
  purama_ai: {
    Tables: Record<string, { Row: Payload; Insert: Payload; Update: Payload; Relationships: [] }>;
    Views: Record<string, never>;
    Functions: Record<string, { Args: Payload; Returns: unknown }>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
interface Dependencies {
  authenticatedClient(header: string): SupabaseClient<EntraideDatabase, 'purama_ai'>;
  serviceClient(): SupabaseClient<EntraideDatabase, 'purama_ai'>;
}

const PROFILE_COLUMNS = 'user_id,skills_offered,skills_needed,availability_days,radius_km,location_lat,location_lng,created_at,updated_at';
const CANDIDATE_LIMIT = 500;

function record(value: unknown): value is Payload { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function rows(value: unknown): Payload[] {
  if (!Array.isArray(value) || value.some(row => !record(row))) throw new Error('invalid_database_response');
  return value as Payload[];
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('invalid_database_response');
  return value as string[];
}
function matchingProfile(profile: Payload, blocked: string[]) {
  if (typeof profile.user_id !== 'string') throw new Error('invalid_database_response');
  const lat = profile.location_lat; const lng = profile.location_lng;
  return {
    userId: profile.user_id,
    skillsOffered: strings(profile.skills_offered), skillsNeeded: strings(profile.skills_needed),
    availabilityDays: strings(profile.availability_days),
    radiusKm: typeof profile.radius_km === 'number' ? profile.radius_km : null,
    location: typeof lat === 'number' && Number.isFinite(lat) && typeof lng === 'number' && Number.isFinite(lng) ? { lat, lng } : null,
    blockedUserIds: blocked,
  };
}

/** The service key stays in the edge runtime. Every privileged read is scoped here. */
export function createSupabaseEntraidePorts(dependencies: Dependencies): EntraidePorts {
  const getProfile = async (actor: string): Promise<Payload | null> => {
    const { data, error } = await dependencies.serviceClient().from('entraide_profils')
      .select(PROFILE_COLUMNS).eq('user_id', actor).maybeSingle();
    if (error || (data !== null && !record(data))) throw new Error('profile_read_failed');
    if (data && data.user_id !== actor) throw new Error('profile_scope_mismatch');
    return data;
  };
  return {
    async authenticate(header) {
      const { data, error } = await dependencies.authenticatedClient(header).auth.getUser();
      if (error) {
        // A network/auth-server outage is not evidence of an invalid identity.
        if (typeof error.status !== 'number' || error.status >= 500 || error.status === 429) throw new Error('auth_unavailable');
        return null;
      }
      return data.user ? { id: data.user.id } : null;
    },
    getProfile,
    async saveProfile(actor, payload) {
      const { error } = await dependencies.serviceClient().from('entraide_profils').upsert(
        [{ ...payload, user_id: actor, updated_at: new Date().toISOString() }],
        { onConflict: 'user_id', defaultToNull: false },
      );
      if (error) throw new Error('profile_write_failed');
    },
    async getMatches(actor) {
      const mine = await getProfile(actor);
      if (!mine) return { matches: [], scanned_profiles: 0, truncated: false };
      const service = dependencies.serviceClient();
      const [profiles, blocks] = await Promise.all([
        service.from('entraide_profils').select(PROFILE_COLUMNS).neq('user_id', actor)
          .order('user_id', { ascending: true }).limit(CANDIDATE_LIMIT + 1),
        service.from('entraide_blocages').select('blocker_id,blocked_id')
          .or(`blocker_id.eq.${actor},blocked_id.eq.${actor}`),
      ]);
      if (profiles.error || blocks.error) throw new Error('matches_read_failed');
      const candidates = rows(profiles.data);
      const blocked = rows(blocks.data).map(block => {
        if (block.blocker_id === actor && typeof block.blocked_id === 'string') return block.blocked_id;
        if (block.blocked_id === actor && typeof block.blocker_id === 'string') return block.blocker_id;
        throw new Error('block_scope_mismatch');
      });
      const ownProfile = matchingProfile(mine, blocked);
      const matches = candidates.slice(0, CANDIDATE_LIMIT).map(candidate => {
        const { score, reasons } = computeMatchScore(ownProfile, matchingProfile(candidate, []));
        return { userId: candidate.user_id, score, reasons };
      }).filter(match => match.score > 0).sort((a, b) => b.score - a.score || String(a.userId).localeCompare(String(b.userId)));
      // Exact coordinates and third-party blocking lists never leave this function.
      return { matches, scanned_profiles: Math.min(candidates.length, CANDIDATE_LIMIT), truncated: candidates.length > CANDIDATE_LIMIT };
    },
    async command(kind, actor, action, payload) {
      const { data, error } = await dependencies.serviceClient().rpc(`entraide_${kind}_command`, {
        p_actor: actor, p_action: action, p_payload: payload,
      });
      if (error || !record(data)) throw new Error('command_failed');
      return data;
    },
  };
}
