-- 006 — Index partiel pour reconcileStaleRuns (P0 IAO 2026-09-26)
--
-- logger.reconcileStaleRuns() filtre `status='running' AND created_at < now()-1h` à CHAQUE
-- démarrage du worker. Sans index, ce filtre scanne karta_runs — table append-only jamais
-- purgée (logs immuables), donc le coût du scan croît sans borne avec l'historique.
-- L'index partiel ne contient que les lignes "running" (en pratique : les cycles en cours,
-- quelques unités) — quasi vide, tenu à jour par l'écriture, et rend la réconciliation
-- O(lignes réconciliées) au lieu de O(table).
-- À appliquer sur le schéma purama_ai (cf migrations 001-005).

CREATE INDEX IF NOT EXISTS idx_karta_runs_stale_running
  ON purama_ai.karta_runs (created_at)
  WHERE status = 'running';
