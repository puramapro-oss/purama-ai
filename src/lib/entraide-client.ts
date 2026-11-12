// Le snapshot généré de Database précède les migrations Entraide.
// Extension locale conforme aux migrations ; conserve le même client et sa session.
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';

type Table<Row, Required extends keyof Row> = {
  Row: Row;
  Insert: Pick<Row, Required> & Partial<Omit<Row, Required>>;
  Update: Partial<Row>;
  Relationships: [];
};

type ProfileRow = {
  user_id: string;
  skills_offered: string[];
  skills_needed: string[];
  availability_days: string[];
  radius_km: number | null;
  location_lat: number | null;
  location_lng: number | null;
  created_at: string;
  updated_at: string;
};
type MissionRow = {
  id: string;
  organizer_id: string;
  title: string;
  description: string;
  min_participants: number;
  max_participants: number | null;
  status: 'ouverte' | 'prete' | 'en_cours' | 'terminee' | 'annulee';
  version: number;
  created_at: string;
  updated_at: string;
};
type ContactRow = {
  id: string;
  requester_id: string;
  recipient_id: string;
  status: 'pending' | 'accepted' | 'declined' | 'expired' | 'blocked';
  message: string | null;
  created_at: string;
  responded_at: string | null;
};

type EntraideDatabase = Omit<Database, 'purama_ai'> & {
  purama_ai: Omit<Database['purama_ai'], 'Tables' | 'Functions'> & {
    Tables: Database['purama_ai']['Tables'] & {
      entraide_profils: Table<ProfileRow, 'user_id'>;
      entraide_blocages: Table<{ blocker_id: string; blocked_id: string; created_at: string }, 'blocker_id' | 'blocked_id'>;
      missions_collectives: Table<MissionRow, 'organizer_id' | 'title' | 'min_participants'>;
      missions_collectives_participants: Table<{ mission_id: string; user_id: string; joined_at: string }, 'mission_id' | 'user_id'>;
      entraide_contact_requests: Table<ContactRow, 'requester_id' | 'recipient_id'>;
      entraide_signalements: Table<{ id: string; reporter_id: string; target_id: string; reason: string; created_at: string }, 'reporter_id' | 'target_id' | 'reason'>;
    };
    Functions: Database['purama_ai']['Functions'] & {
      entraide_own_profile: { Args: Record<string, never>; Returns: ProfileRow | null };
    };
  };
};

// Aucun nouveau stockage de session ni nouveau client réseau.
export const entraideSupabase = supabase as unknown as SupabaseClient<EntraideDatabase, 'purama_ai'>;
