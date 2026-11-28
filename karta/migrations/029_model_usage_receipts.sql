-- Provider-reported token metadata on the existing, server-owned run journal.
-- Apply before the code that closes runs with model_usage. No pricing, credits,
-- quota mutation, new ledger, provider call, policy or grant is introduced.
-- Historical rows stay NULL: absent usage must never be interpreted as zero.
BEGIN;
ALTER TABLE purama_ai.karta_runs ADD COLUMN IF NOT EXISTS model_usage jsonb;
ALTER TABLE purama_ai.karta_runs DROP CONSTRAINT IF EXISTS karta_runs_model_usage_shape;
ALTER TABLE purama_ai.karta_runs ADD CONSTRAINT karta_runs_model_usage_shape
  CHECK (model_usage IS NULL OR (
    jsonb_typeof(model_usage) = 'object'
    AND pg_column_size(model_usage) <= 4096
    AND model_usage ?& ARRAY['version', 'apiFormat', 'routeKind', 'requestedModel', 'responseModel', 'responseId', 'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'cacheCreation5mInputTokens', 'cacheCreation1hInputTokens']
    AND model_usage - ARRAY['version', 'apiFormat', 'routeKind', 'requestedModel', 'responseModel', 'responseId', 'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'cacheCreation5mInputTokens', 'cacheCreation1hInputTokens'] = '{}'::jsonb
    AND model_usage->'version' = '1'::jsonb
    AND model_usage->>'apiFormat' = 'anthropic_messages'
    AND model_usage->>'routeKind' IN ('anthropic', 'compatible')
    AND (model_usage->'requestedModel' = 'null'::jsonb OR (jsonb_typeof(model_usage->'requestedModel') = 'string' AND length(model_usage->>'requestedModel') BETWEEN 1 AND 200 AND model_usage->>'requestedModel' ~ '^[A-Za-z0-9]' AND model_usage->>'requestedModel' !~ '[^A-Za-z0-9_.:/-]'))
    AND (model_usage->'responseModel' = 'null'::jsonb OR (jsonb_typeof(model_usage->'responseModel') = 'string' AND length(model_usage->>'responseModel') BETWEEN 1 AND 200 AND model_usage->>'responseModel' ~ '^[A-Za-z0-9]' AND model_usage->>'responseModel' !~ '[^A-Za-z0-9_.:/-]'))
    AND (model_usage->'responseId' = 'null'::jsonb OR (jsonb_typeof(model_usage->'responseId') = 'string' AND length(model_usage->>'responseId') BETWEEN 1 AND 200 AND model_usage->>'responseId' ~ '^[A-Za-z0-9]' AND model_usage->>'responseId' !~ '[^A-Za-z0-9_.:/-]'))
    AND (model_usage->'inputTokens' = 'null'::jsonb OR (jsonb_typeof(model_usage->'inputTokens') = 'number' AND (model_usage->>'inputTokens')::numeric BETWEEN 0 AND 9007199254740991 AND trunc((model_usage->>'inputTokens')::numeric) = (model_usage->>'inputTokens')::numeric))
    AND (model_usage->'outputTokens' = 'null'::jsonb OR (jsonb_typeof(model_usage->'outputTokens') = 'number' AND (model_usage->>'outputTokens')::numeric BETWEEN 0 AND 9007199254740991 AND trunc((model_usage->>'outputTokens')::numeric) = (model_usage->>'outputTokens')::numeric))
    AND (model_usage->'cacheReadInputTokens' = 'null'::jsonb OR (jsonb_typeof(model_usage->'cacheReadInputTokens') = 'number' AND (model_usage->>'cacheReadInputTokens')::numeric BETWEEN 0 AND 9007199254740991 AND trunc((model_usage->>'cacheReadInputTokens')::numeric) = (model_usage->>'cacheReadInputTokens')::numeric))
    AND (model_usage->'cacheCreationInputTokens' = 'null'::jsonb OR (jsonb_typeof(model_usage->'cacheCreationInputTokens') = 'number' AND (model_usage->>'cacheCreationInputTokens')::numeric BETWEEN 0 AND 9007199254740991 AND trunc((model_usage->>'cacheCreationInputTokens')::numeric) = (model_usage->>'cacheCreationInputTokens')::numeric))
    AND (model_usage->'cacheCreation5mInputTokens' = 'null'::jsonb OR (jsonb_typeof(model_usage->'cacheCreation5mInputTokens') = 'number' AND (model_usage->>'cacheCreation5mInputTokens')::numeric BETWEEN 0 AND 9007199254740991 AND trunc((model_usage->>'cacheCreation5mInputTokens')::numeric) = (model_usage->>'cacheCreation5mInputTokens')::numeric))
    AND (model_usage->'cacheCreation1hInputTokens' = 'null'::jsonb OR (jsonb_typeof(model_usage->'cacheCreation1hInputTokens') = 'number' AND (model_usage->>'cacheCreation1hInputTokens')::numeric BETWEEN 0 AND 9007199254740991 AND trunc((model_usage->>'cacheCreation1hInputTokens')::numeric) = (model_usage->>'cacheCreation1hInputTokens')::numeric))
  ) IS TRUE);
COMMENT ON COLUMN purama_ai.karta_runs.model_usage IS
  'Versioned provider token receipt, recorded with the immutable first close; NULL is unknown. Not a reconciled invoice. Cache TTL buckets are not additional totals.';
COMMIT;
