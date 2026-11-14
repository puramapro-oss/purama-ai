-- ENTRAIDE: prevent authenticated clients from reading precise profile coordinates.
-- Matching remains server-side through service_role; profile owners use the app API.
REVOKE SELECT ON purama_ai.entraide_profils FROM authenticated;
GRANT SELECT (
  user_id,
  skills_offered,
  skills_needed,
  availability_days,
  radius_km,
  created_at,
  updated_at
) ON purama_ai.entraide_profils TO authenticated;
