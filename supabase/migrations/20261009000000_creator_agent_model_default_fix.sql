-- purama-ai — correction SARVA (routage modèle Claude obsolète), suite de T1-IAO-PURAMA-ONE.
-- 20260407000000_creator_agent.sql fige 'claude-sonnet-4-20250514' en DEFAULT de colonne (L23)
-- + dans 8 lignes de seed (agents template, user_id NULL) — jamais corrigé rétroactivement par
-- principe (migration déjà appliquée). Migration additive uniquement : ALTER DEFAULT + UPDATE
-- ciblé sur la valeur littérale exacte (idempotent, ré-exécutable sans effet si déjà appliqué).

ALTER TABLE purama_ai.creator_agents
  ALTER COLUMN model SET DEFAULT 'claude-sonnet-4-6';

UPDATE purama_ai.creator_agents
SET model = 'claude-sonnet-4-6',
    updated_at = now()
WHERE model = 'claude-sonnet-4-20250514';
