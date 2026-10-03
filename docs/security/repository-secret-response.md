# Repository secret and supply-chain response

## Confirmed remediation

- Literal credentials were removed from tracked deployment scripts and internal briefs.
- Production test secrets are scoped to the Playwright command instead of the entire job.
- Production Playwright reports are no longer uploaded because they may contain request traces.
- Root GitHub Actions are pinned to immutable commit SHAs.
- DocuSeal deployment now requires credentials from the environment and an image pinned by digest.
- OAuth token endpoint response bodies are no longer written to logs.
- CI rejects recognized credential formats, literal secret assignments, unpinned root Actions,
  pipe-to-shell installers, and `pull_request_target` workflows.

## Required external response

Removing a value from the current tree does not remove it from Git history. Rotate every credential
that appeared literally, including the affected DocuSeal, email delivery, Google OAuth, research,
and search-provider credentials. Review provider audit logs from the first commit containing each
credential until rotation. Do not paste replacement values into an issue, pull request, CI log, or
commit.

If policy requires historical erasure, coordinate a dedicated history rewrite and invalidate all
old clones and caches. Rotation must happen regardless of whether history is rewritten.
