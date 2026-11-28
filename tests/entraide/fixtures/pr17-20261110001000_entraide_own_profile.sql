-- Read precise coordinates only for the authenticated owner's own profile.
-- Public profile columns keep their existing SELECT policy and grants.
-- No user ID argument, and no coordinate SELECT grant to authenticated/anon.
CREATE OR REPLACE FUNCTION purama_ai.entraide_own_profile()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT pg_catalog.to_jsonb(profil)
  FROM purama_ai.entraide_profils AS profil
  WHERE profil.user_id = (SELECT auth.uid());
$$;

REVOKE ALL ON FUNCTION purama_ai.entraide_own_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION purama_ai.entraide_own_profile() TO authenticated;

COMMENT ON FUNCTION purama_ai.entraide_own_profile() IS
  'Own entraide profile only, including private coordinates; identity comes from auth.uid(), never a parameter.';
