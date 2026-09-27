-- Documents générés par KARTA : bucket privé, jamais de lien public permanent.
BEGIN;

INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'agent-documents',
  'agent-documents',
  false,
  10485760,
  ARRAY['application/pdf']::text[]
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Aucun accès direct anon/authenticated n'est accordé ici.
-- KARTA (service_role) crée l'objet et émet un signed URL temporaire.
DROP POLICY IF EXISTS "Public read agent documents" ON storage.objects;
DROP POLICY IF EXISTS "Users read agent documents" ON storage.objects;
DROP POLICY IF EXISTS "Users write agent documents" ON storage.objects;

COMMIT;
