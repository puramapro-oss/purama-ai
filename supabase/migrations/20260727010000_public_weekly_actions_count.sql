-- Compteur public home "X actions exécutées par nos employés IA cette semaine" (brief PRICING &
-- OFFRE IRRÉSISTIBLE). karta_runs est protégé par RLS (auth.uid() = user_id, cf migration 001) —
-- une fonction SECURITY DEFINER expose UNIQUEMENT un agrégat (aucune ligne, aucune donnée
-- utilisateur) aux visiteurs anonymes de la home.

CREATE OR REPLACE FUNCTION purama_ai.public_weekly_actions_count()
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
SET search_path = purama_ai, public
STABLE
AS $$
  SELECT count(*)::BIGINT
  FROM purama_ai.karta_runs
  WHERE started_at >= now() - interval '7 days'
    AND status IN ('success', 'error');
$$;

GRANT EXECUTE ON FUNCTION purama_ai.public_weekly_actions_count() TO anon, authenticated;
