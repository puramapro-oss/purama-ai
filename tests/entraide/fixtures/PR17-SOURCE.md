# Inert PR #17 migration fixtures

These files are copied verbatim from `puramapro-oss/purama-ai` commit
`0660d23c28e48ac0522725546848b0c842202708`, the inspected PR #17 head.
They are test fixtures, outside `supabase/migrations`, and are never selected by
the application migration runner.

`pr17-20261110000000_entraide_missions_atomic.sql` has SHA-256
`f79766b153806bdd6aac382b66c1d8495133c766fc35a50675a32894670d7c36`.
The SQL body stored in `pg_proc.prosrc` has SHA-256
`f196ea13a6460a7985eddbfd6c604d458388a86b96d934751e6dee0c17906b40`.
The bridge requires that exact body plus its security mode and expected storage.
The executable test asserts the fixture file digest before applying it.

The own-profile fixture verifies that the retained `auth.uid()`-scoped coordinate
reader remains private during the transition. No shared checkout is modified.

## Already-applied PR #23 fixture

`pr23-20261110021000_entraide_missions_atomic.sql` is copied verbatim from PR #23
commit `eb09c6d1a1c134bbf430f20c3fb6f94f8ec3afcb`. Its file SHA-256 is
`8b408c43e4a12609eac882797f2fc88d8a0c48366b7646aab71d39d9cefcdf72`;
its `entraide_mission_command` body SHA-256 is
`4699b943a2bbffe7da7310832f15c479d96149ec72f80642efcc6745fffb0edc`.
The upgrade test executes it once, then deliberately skips its recorded version
and applies only the additive migration. It does not rewrite migration history.
