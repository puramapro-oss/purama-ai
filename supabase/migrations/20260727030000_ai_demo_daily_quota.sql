-- Plafond journalier global sur la démo publique sans inscription (ai-demo edge function).
-- Le rate limit en mémoire (_shared/rate-limit.ts, 5/heure/IP) ne survit pas à un
-- docker compose up --force-recreate functions (recréé à chaque déploiement) et n'est pas
-- partagé entre isolates concurrents — donc pas un vrai plafond de coût pour un endpoint public
-- non authentifié qui appelle Claude en direct. Ce compteur journalier atomique en base ferme
-- ce trou (cf revue /simplify altitude, ERRORS.md 2026-07-27).

CREATE TABLE IF NOT EXISTS purama_ai.demo_usage_daily (
  day DATE PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE purama_ai.demo_usage_daily ENABLE ROW LEVEL SECURITY;
-- Aucune policy : accès exclusivement via la fonction SECURITY DEFINER ci-dessous (service_role).

CREATE OR REPLACE FUNCTION purama_ai.increment_demo_quota(p_max_per_day INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = purama_ai, public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO purama_ai.demo_usage_daily (day, count)
  VALUES (CURRENT_DATE, 1)
  ON CONFLICT (day) DO UPDATE SET count = purama_ai.demo_usage_daily.count + 1
  RETURNING count INTO v_count;

  RETURN v_count <= p_max_per_day;
END;
$$;

GRANT EXECUTE ON FUNCTION purama_ai.increment_demo_quota(INTEGER) TO service_role;
