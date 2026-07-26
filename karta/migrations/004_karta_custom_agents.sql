-- KARTA Engine — Phase 3 : "Agent Créateur d'Agents" passe en exécution réelle
-- Réutilise creator_agents (déjà existante, chat-only jusqu'ici) au lieu de dupliquer une table.
-- Réutilise aussi karta_agent_state/karta_runs (agent_type='custom:<id>') pour autonomie/kill
-- switch/simulation/logs — 0 nouvelle table pour ça, cf karta/src/agents/customAgent.ts.
SET search_path TO purama_ai;

ALTER TABLE purama_ai.creator_agents
  ADD COLUMN IF NOT EXISTS karta_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN purama_ai.creator_agents.karta_enabled IS
  'true = agent exécuté réellement par KARTA Engine (outils, autonomie, planification) en plus du chat. false = chat uniquement (comportement historique).';
