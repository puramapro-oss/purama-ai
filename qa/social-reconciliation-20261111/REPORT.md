# Social integration — local qualification, 11 November 2026

## Result and scope

**PASS for the local source gates listed below.** This isolated candidate starts from `f7660e43bb72b29408611593d62c1bcee53ce4a1` and preserves the ancestry of social PR22, `fb2e7ea6aa1b8d35d54702927112f40e8ae82ac9`, through a controlled merge. The qualified source tree is `ce02db70bb0d4bb4127939713f32add59b7c1813`; proof files are added separately.

The source delta comprises 43 social production/test/migration files, the two social changes in `assistantPolicy.test.ts`, the union of CI gates, and two additional files for the reproduced agent-execution lifetime defect. The remaining current financial handlers, journal/projection, R3/offline UI, provider fixtures, billing timeout wrapper, package locks and creator-agent ownership correction are unchanged from the base. The older financial portion and historical QA documents of PR22 were not copied over the current versions.

## Reproduced defects and corrections

The original social form launched autopilot in the background without an abortable lifetime. Nine independent browser probes produced **5 PASS / 4 FAIL** with unchanged inputs: a delayed configuration response still caused a publication after A→B→A, logout/login, view unmount or agent change. The corrected form gives each background autopilot its own lease and releases it only when the operation settles. A new generation can still start while autopilot waits. All nine probes now pass within the 29-scenario browser suite; the manual publication callback remains inert after A→B→A and retry retains the same request identity for the same intent.

An independent review reproduced stale continuations in `useAgentExecution`, then a narrower case where the SDK session moved to B before React committed while usage still named A. The hook now captures the owner bearer, keeps leases across awaits, and places that bearer on both PostgREST builders without mutating the shared client. The final **11/11** suite includes the real Supabase/PostgREST SDK with inert fetch. The copied root receipt preserves all red and green phases and their log hashes. Its `production_sha256` field identifies the final hook; `after_sha256` belongs to the earlier intermediate phase.

## Executed gates

| Gate | Observed result |
|---|---:|
| Deno social core |104/104 PASS|
| Actual routes with real Supabase SDK |14/14 PASS|
| Social publication/binding SQL with PGlite |40/40 PASS|
| KARTA assistant policy, one worker |55/55 PASS|
| Browser scenarios, actual Chrome 157 |29/29 PASS|
| Agent execution, including actual SDK bearer case |11/11 PASS|
| Production SDK type check for six social routes |PASS|
| Generated database contracts |PASS|
| App TypeScript, production Vite build |PASS|
| Full site ESLint |0 errors,21 warnings outside changed paths|
| Parsed workflow union |All prior steps retained unchanged and in order|

The first local Vitest invocation failed before test execution because `--minWorkers` is unsupported by installed Vitest 5. It is preserved as evidence; the corrected one-worker invocation passed 55/55. Existing ESLint configuration excludes the JSX browser harness; the harness was compiled and executed by the browser suite. No assertion, browser sandbox, network denial or test deadline was relaxed.

The server sources, migrations, SDK fixtures and assistant-policy inputs remained byte-identical between their first successful gates and the final UI tree. They were not needlessly rerun after client-only corrections. The final browser, hook, typecheck, build and lint recorded identical source fingerprints before and after execution.

## CI and preservation

The workflow retains 12 existing KARTA steps, 43 site steps and 4 subscription-concurrency steps. It adds one social SQL step and four site steps: core behavior, agent lifetime, real Supabase SDK, and browser scenarios. The Stripe SDK and revenue SQL gate each occur exactly once. Native OAuth and subscription gates, the Node22 commands and the actual 30000 ms test-file limit remain intact.

All dependencies were reused after lock-version comparison; no package was installed and no application lock changed. Root 641 and KARTA 160 installed package paths matched their lock versions. The native pg 8.23.1 family was unavailable locally and unused by these social SQL gates, which used exact PGlite 0.5.8. Runtime versions and command, cwd, exit, duration, hashes and counts for each gate are recorded in `verification.json`.

## Graph review and evidence

The initial index and 29 pre-edit impact calls were completed before the merge. They reported 17 LOW, 2 MEDIUM and 10 UNKNOWN, with no HIGH/CRITICAL target; UNKNOWN and FTS/process limitations were explicitly supplemented by text review and the targeted suites. Post-integration index and staged/default-main/base comparisons are required before the local commit; their receipt paths are recorded in `verification.json`, and the immutable commit/tree plus graph summaries belong to the final handoff. No absence-of-edge claim is treated as proof of safety.

`source-manifest.json` identifies the exact qualified inputs. `agent-execution-review.json` preserves the independent hook evidence. Full logs and earlier failures remain in this clone under `.git/social-gates` and `.git/root-agent-execution-review`; the JSON records their SHA256 values.

## Boundaries and remaining integration

This phase performs no push, PR mutation, new CI trigger, deployment, hosted migration or actual provider operation. The browser completed with zero page errors, failed local resources or external requests. Runtime Deno suites deny network and subprocess permissions; no claim of network tracing is made for the separate cached-only SDK type check, whose diagnostics are preserved.

The final combined Linux CI remains to be run by the coordinating agent in the common PR45. This local macOS qualification does not claim a full KARTA/mobile rerun, dependency audit, production load test or live OAuth/publication success. Before any future deployment, apply 00300 before 00400 in the reviewed existing schema, preserve legacy/uncertain rows for reconciliation, and keep X funding and paid-caption gates closed until their server prerequisites are available.
