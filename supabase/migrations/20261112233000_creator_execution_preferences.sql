-- Saved task-execution preferences. Existing row ownership and grants remain
-- unchanged; these values never qualify a model or authorize a provider call.
BEGIN;

ALTER TABLE purama_ai.creator_agents
  ADD COLUMN execution_preferences JSONB NOT NULL
  DEFAULT '{"reflection":"auto","speed":"standard"}'::jsonb;

ALTER TABLE purama_ai.creator_agents
  ADD CONSTRAINT creator_agents_execution_preferences_check CHECK (
    jsonb_typeof(execution_preferences) = 'object'
    AND execution_preferences ?& ARRAY['reflection', 'speed']
    AND execution_preferences - 'reflection' - 'speed' = '{}'::jsonb
    AND jsonb_typeof(execution_preferences -> 'reflection') = 'string'
    AND jsonb_typeof(execution_preferences -> 'speed') = 'string'
    AND execution_preferences ->> 'reflection' IN ('auto', 'standard', 'deep', 'maximum')
    AND execution_preferences ->> 'speed' IN ('standard', 'fast', 'ultra_fast')
  );

COMMENT ON COLUMN purama_ai.creator_agents.execution_preferences IS
  'Task execution reflection and speed preferences; validated against the host model catalogue at execution time.';

COMMIT;
