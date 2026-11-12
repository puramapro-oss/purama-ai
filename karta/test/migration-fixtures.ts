// Explicit fixture manifests keep unrelated KARTA additions out of CHEF-only
// databases. These are source fixtures, not a deployment migration runner.
export const CHEF_CORE_MIGRATIONS = [
  "008_chef_control_plane.sql",
  "009_chef_hardening.sql",
  "010_chef_reliability.sql",
  "011_chef_runtime_policy.sql",
  "012_chef_mission_ingest.sql",
  "013_chef_independent_review.sql",
  "014_chef_file_ownership.sql",
  "015_chef_mission_file_ownership.sql",
  "016_chef_scoped_evidence.sql",
  "017_chef_evidence_generation.sql",
] as const;

export const CHEF_ADMISSION_MIGRATIONS = [
  ...CHEF_CORE_MIGRATIONS,
  "021_chef_budget_admission.sql",
  "022_chef_mission_estimates.sql",
  "023_chef_process_quarantine.sql",
] as const;

export const CHEF_RECONCILIATION_MIGRATIONS = [
  ...CHEF_ADMISSION_MIGRATIONS,
  "024_chef_claim_budget_reconciliation.sql",
] as const;

export const KARTA_COMMON_MIGRATIONS = [
  "001_karta_core.sql",
  "002_karta_global_kill_switch.sql",
  "003_karta_crm_leads.sql",
  "004_karta_custom_agents.sql",
  "005_karta_pending_actions.sql",
  "006_execution_claims.sql",
  "007_runtime_hardening.sql",
  ...CHEF_CORE_MIGRATIONS,
  "018_karta_brief_claims.sql",
  "019_karta_approval_parent_guard.sql",
  "020_execution_fingerprints.sql",
] as const;

export const KARTA_PR33_ADDITIONS = [
  "021_chef_budget_admission.sql",
  "022_chef_mission_estimates.sql",
  "023_chef_process_quarantine.sql",
  "024_chef_claim_budget_reconciliation.sql",
  "025_brief_submission.sql",
] as const;

export const KARTA_CANONICAL_MIGRATIONS = [
  ...KARTA_COMMON_MIGRATIONS,
  ...KARTA_PR33_ADDITIONS,
  "026_pending_action_execution_origin.sql",
  "027_approval_continuation_outbox.sql",
  "028_model_usage_receipts.sql",
] as const;
