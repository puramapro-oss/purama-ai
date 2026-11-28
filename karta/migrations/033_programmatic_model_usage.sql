-- Extend the existing immutable run metadata without changing ownership,
-- grants, retention, model choice, budgets or the meaning of historical v1.
-- Apply before enabling KARTA_ANTHROPIC_PROGRAMMATIC_READS=on.
BEGIN;
CREATE OR REPLACE FUNCTION purama_ai.karta_valid_model_usage_receipt(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $receipt$
  SELECT (
    jsonb_typeof(value) = 'object'
    AND pg_column_size(value) <= 4096
    AND value ?& ARRAY['version', 'apiFormat', 'routeKind', 'requestedModel', 'responseModel', 'responseId', 'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'cacheCreation5mInputTokens', 'cacheCreation1hInputTokens']
    AND value - ARRAY['version', 'apiFormat', 'routeKind', 'requestedModel', 'responseModel', 'responseId', 'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'cacheCreation5mInputTokens', 'cacheCreation1hInputTokens'] = '{}'::jsonb
    AND value->'version' = '1'::jsonb
    AND value->>'apiFormat' = 'anthropic_messages'
    AND value->>'routeKind' IN ('anthropic', 'compatible')
    AND (value->'requestedModel' = 'null'::jsonb OR (jsonb_typeof(value->'requestedModel') = 'string' AND length(value->>'requestedModel') BETWEEN 1 AND 200 AND value->>'requestedModel' ~ '^[A-Za-z0-9]' AND value->>'requestedModel' !~ '[^A-Za-z0-9_.:/-]'))
    AND (value->'responseModel' = 'null'::jsonb OR (jsonb_typeof(value->'responseModel') = 'string' AND length(value->>'responseModel') BETWEEN 1 AND 200 AND value->>'responseModel' ~ '^[A-Za-z0-9]' AND value->>'responseModel' !~ '[^A-Za-z0-9_.:/-]'))
    AND (value->'responseId' = 'null'::jsonb OR (jsonb_typeof(value->'responseId') = 'string' AND length(value->>'responseId') BETWEEN 1 AND 200 AND value->>'responseId' ~ '^[A-Za-z0-9]' AND value->>'responseId' !~ '[^A-Za-z0-9_.:/-]'))
    AND (value->'inputTokens' = 'null'::jsonb OR (jsonb_typeof(value->'inputTokens') = 'number' AND (value->>'inputTokens')::numeric BETWEEN 0 AND 9007199254740991 AND trunc((value->>'inputTokens')::numeric) = (value->>'inputTokens')::numeric))
    AND (value->'outputTokens' = 'null'::jsonb OR (jsonb_typeof(value->'outputTokens') = 'number' AND (value->>'outputTokens')::numeric BETWEEN 0 AND 9007199254740991 AND trunc((value->>'outputTokens')::numeric) = (value->>'outputTokens')::numeric))
    AND (value->'cacheReadInputTokens' = 'null'::jsonb OR (jsonb_typeof(value->'cacheReadInputTokens') = 'number' AND (value->>'cacheReadInputTokens')::numeric BETWEEN 0 AND 9007199254740991 AND trunc((value->>'cacheReadInputTokens')::numeric) = (value->>'cacheReadInputTokens')::numeric))
    AND (value->'cacheCreationInputTokens' = 'null'::jsonb OR (jsonb_typeof(value->'cacheCreationInputTokens') = 'number' AND (value->>'cacheCreationInputTokens')::numeric BETWEEN 0 AND 9007199254740991 AND trunc((value->>'cacheCreationInputTokens')::numeric) = (value->>'cacheCreationInputTokens')::numeric))
    AND (value->'cacheCreation5mInputTokens' = 'null'::jsonb OR (jsonb_typeof(value->'cacheCreation5mInputTokens') = 'number' AND (value->>'cacheCreation5mInputTokens')::numeric BETWEEN 0 AND 9007199254740991 AND trunc((value->>'cacheCreation5mInputTokens')::numeric) = (value->>'cacheCreation5mInputTokens')::numeric))
    AND (value->'cacheCreation1hInputTokens' = 'null'::jsonb OR (jsonb_typeof(value->'cacheCreation1hInputTokens') = 'number' AND (value->>'cacheCreation1hInputTokens')::numeric BETWEEN 0 AND 9007199254740991 AND trunc((value->>'cacheCreation1hInputTokens')::numeric) = (value->>'cacheCreation1hInputTokens')::numeric))
  ) IS TRUE;
$receipt$;

CREATE OR REPLACE FUNCTION purama_ai.karta_valid_model_usage_envelope(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $envelope$
  SELECT CASE
    WHEN purama_ai.karta_valid_model_usage_receipt(value) THEN true
    WHEN jsonb_typeof(value) = 'object'
      AND pg_column_size(value) <= 32768
      AND value ?& ARRAY['version','apiFormat','routeKind','responses']
      AND value - ARRAY['version','apiFormat','routeKind','responses'] = '{}'::jsonb
      AND value->'version' = '2'::jsonb
      AND value->>'apiFormat' = 'anthropic_messages'
      AND value->>'routeKind' = 'anthropic'
      AND jsonb_typeof(value->'responses') = 'array'
    THEN CASE WHEN jsonb_array_length(value->'responses') BETWEEN 1 AND 8 THEN (
      SELECT bool_and((
        jsonb_typeof(item) = 'object'
        AND item ?& ARRAY['receipt','codeExecutionRequests']
        AND item - ARRAY['receipt','codeExecutionRequests'] = '{}'::jsonb
        AND purama_ai.karta_valid_model_usage_receipt(item->'receipt')
        AND item->'receipt'->>'routeKind' = 'anthropic'
        AND (item->'codeExecutionRequests' = 'null'::jsonb OR (
          jsonb_typeof(item->'codeExecutionRequests') = 'number'
          AND (item->>'codeExecutionRequests')::numeric BETWEEN 0 AND 9007199254740991
          AND trunc((item->>'codeExecutionRequests')::numeric) = (item->>'codeExecutionRequests')::numeric
        ))
      ) IS TRUE) FROM jsonb_array_elements(value->'responses') AS item
    ) ELSE false END
    ELSE false
  END;
$envelope$;

ALTER TABLE purama_ai.karta_runs DROP CONSTRAINT IF EXISTS karta_runs_model_usage_shape;
ALTER TABLE purama_ai.karta_runs ADD CONSTRAINT karta_runs_model_usage_shape
  CHECK (model_usage IS NULL OR purama_ai.karta_valid_model_usage_envelope(model_usage) IS TRUE);
COMMENT ON COLUMN purama_ai.karta_runs.model_usage IS
  'Immutable provider metadata: v1 one response; v2 ordered bounded PTC responses, each with its own token/cache and server-code count. NULL counters are unknown; no price or reconciled invoice.';
COMMIT;
