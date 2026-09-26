-- 007 — Index partiel pour reconcileOrphanPendingActions (P0 IAO 2026-09-26)
--
-- approval.reconcileOrphanPendingActions() filtre `status='processing' AND resolved_at <
-- now()-10min` à CHAQUE démarrage du worker. L'index existant (005) est (user_id, status,
-- created_at) — user_id non borné ici → seq scan d'une table append-only. L'index partiel ne
-- contient que les lignes "processing" (quelques secondes de vie en pratique) — quasi vide,
-- et rend la réconciliation O(orphelins). Même pattern que la migration 006 (karta_runs).

CREATE INDEX IF NOT EXISTS idx_karta_pending_actions_processing
  ON purama_ai.karta_pending_actions (resolved_at)
  WHERE status = 'processing';
