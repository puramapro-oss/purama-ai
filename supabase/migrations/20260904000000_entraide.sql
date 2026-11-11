-- Migration entraide — 5 tables MOULE-ENTRAIDE.md §7, schema purama_ai.
-- Mise en relation, missions collectives (≠ missions solo), contact sécurisé, blocage, signalement.

-- Profils de mise en relation (opt-in, 1 ligne par user qui active).
CREATE TABLE IF NOT EXISTS purama_ai.entraide_profils (
  user_id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  skills_offered     text[] NOT NULL DEFAULT '{}',
  skills_needed      text[] NOT NULL DEFAULT '{}',
  availability_days  text[] NOT NULL DEFAULT '{}',
  radius_km          integer,
  location_lat       double precision,
  location_lng       double precision,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE purama_ai.entraide_profils ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY entraide_profils_read_all ON purama_ai.entraide_profils
    FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY entraide_profils_write_self ON purama_ai.entraide_profils
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON purama_ai.entraide_profils TO authenticated;
GRANT ALL ON purama_ai.entraide_profils TO service_role;

-- Blocage unilatéral (n'implique jamais la personne bloquée).
CREATE TABLE IF NOT EXISTS purama_ai.entraide_blocages (
  blocker_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);
ALTER TABLE purama_ai.entraide_blocages ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY entraide_blocages_self ON purama_ai.entraide_blocages
    FOR ALL USING (auth.uid() = blocker_id) WITH CHECK (auth.uid() = blocker_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, DELETE ON purama_ai.entraide_blocages TO authenticated;
GRANT ALL ON purama_ai.entraide_blocages TO service_role;

-- Missions COLLECTIVES — table séparée des missions solo existantes (si l'app en a).
CREATE TABLE IF NOT EXISTS purama_ai.missions_collectives (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title             text NOT NULL,
  description       text NOT NULL DEFAULT '',
  min_participants  integer NOT NULL CHECK (min_participants >= 2),
  max_participants  integer,
  status            text NOT NULL DEFAULT 'ouverte'
                     CHECK (status IN ('ouverte','prete','en_cours','terminee','annulee')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (max_participants IS NULL OR max_participants >= min_participants)
);
CREATE TABLE IF NOT EXISTS purama_ai.missions_collectives_participants (
  mission_id  uuid NOT NULL REFERENCES purama_ai.missions_collectives(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mission_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_missions_collectives_status ON purama_ai.missions_collectives(status);
ALTER TABLE purama_ai.missions_collectives ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.missions_collectives_participants ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY missions_collectives_read_all ON purama_ai.missions_collectives
    FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY missions_collectives_participants_read_all ON purama_ai.missions_collectives_participants
    FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT ON purama_ai.missions_collectives, purama_ai.missions_collectives_participants TO authenticated;
GRANT ALL ON purama_ai.missions_collectives, purama_ai.missions_collectives_participants TO service_role;

-- Demandes de contact — jamais de PII, workflow d'autorisation uniquement.
CREATE TABLE IF NOT EXISTS purama_ai.entraide_contact_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','declined','expired','blocked')),
  message       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  responded_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_entraide_contact_requester_day
  ON purama_ai.entraide_contact_requests(requester_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entraide_contact_one_pending
  ON purama_ai.entraide_contact_requests(requester_id, recipient_id)
  WHERE status = 'pending';
ALTER TABLE purama_ai.entraide_contact_requests ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY entraide_contact_requests_parties ON purama_ai.entraide_contact_requests
    FOR SELECT USING (auth.uid() IN (requester_id, recipient_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT ON purama_ai.entraide_contact_requests TO authenticated;
GRANT ALL ON purama_ai.entraide_contact_requests TO service_role;

-- Signalements — lecture réservée service_role/admin.
CREATE TABLE IF NOT EXISTS purama_ai.entraide_signalements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE purama_ai.entraide_signalements ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY entraide_signalements_insert_self ON purama_ai.entraide_signalements
    FOR INSERT WITH CHECK (auth.uid() = reporter_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT INSERT ON purama_ai.entraide_signalements TO authenticated;
GRANT ALL ON purama_ai.entraide_signalements TO service_role;
