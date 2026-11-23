#!/usr/bin/env bash
# Keep the unfiltered diagnostic in the caller's log. Exempt only the first
# appearance of these byte-identical, already archived QA records. Changed
# records, previously present paths, unlisted files and application code stay strict.
# Entries cover archived evidence from 57d3d6b and the IAO qualification b4a18ef.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
base=$1
head=$2
if git diff --check "$base" "$head"; then
  exit 0
else
  status=$?
  [[ $status -eq 2 ]] || exit "$status"
fi

paths=(.)
while read -r blob path; do
  # A mode change, deletion or new revision remains subject to the raw check.
  entry=$(git ls-tree "$head" -- "$path")
  if [[ "$entry" == "100644 blob $blob"$'\t'"$path" ]] &&
     [[ -z $(git ls-tree "$base" -- "$path") ]]; then
    paths+=(":(exclude,literal)$path")
  fi
done <<'ARCHIVED_QA'
bf9d4c2da54a3c4c33ba817312992711f1fa1018 qa/iao-runtime-20261110/native-outbox.py
0fadea946360bdb904954143780e5f739e0d483b qa/reliability-audit-20261110/gitnexus-final/analyze.txt
6149a037a217173048690eeb0190ced93752aa54 qa/reliability-audit-20261110/gmail/before.txt
603767ca198a1efec260bfa6e0ebb929b151fd05 qa/reliability-audit-20261110/late-integration/gitnexus/analyze.txt
b38b4e3cc37bff3992558d6ecd5a93a4ecd23647 qa/reliability-audit-20261110/mac/final-qualification/lint.txt
f1f9f72c59f380b2ad13dd9d7b8bb7e1efbbe309 qa/reliability-audit-20261110/mac/final-qualification/site-types.txt
91dbdb46e187be31370ff108bd31a2f3e06325c3 qa/reliability-audit-20261110/mac/gmail-ui-before/artifacts/email-lifecycle-email-dash-086a8-notify-the-newer-A-lifetime/error-context.md
043be021c0485f9f6b41a7e10330dc2cfacc778e qa/reliability-audit-20261110/mac/gmail-ui-before/artifacts/email-lifecycle-email-dash-5552b-fy-a-later-account-lifetime/error-context.md
bfcbd1b27582f59550219161fa93102fcbfa2bb0 qa/reliability-audit-20261110/mac/gmail-ui-before/artifacts/email-lifecycle-email-sett-a35a9-ns-the-current-pending-save/error-context.md
aa0ab35f27d0ed6ade0f5273915fa3aab64691a8 qa/reliability-audit-20261110/mac/gmail-ui-before/artifacts/email-lifecycle-email-sett-fa5a9-nd-keeps-the-new-connection/error-context.md
9c9cf69f6b824babb19995c3aabde4d53294eb9f qa/reliability-audit-20261110/mac/gmail-ui-before/run.txt
e56a7ae9552f98b8d01e4743be75dcb97a8379fc qa/reliability-audit-20261110/mac/qualification/commerce.txt
825de232caf466a22dea84c39f7051322f7cbceb qa/reliability-audit-20261110/mac/qualification/karta-build.txt
3584b089d529b01400d78ca9d7130ba88c51cdad qa/reliability-audit-20261110/mac/qualification/karta-tests.txt
1f73502e372b487f93a39532013b101895b98430 qa/reliability-audit-20261110/mac/qualification/karta-types.txt
b38b4e3cc37bff3992558d6ecd5a93a4ecd23647 qa/reliability-audit-20261110/mac/qualification/lint.txt
f1f9f72c59f380b2ad13dd9d7b8bb7e1efbbe309 qa/reliability-audit-20261110/mac/qualification/site-types.txt
73633891052def2422bded6b04faaf90e184f4b4 qa/static-scheduler-20261110/baseline-real-cron.log
5db2febd517c4559c8329aca85cb4f68b3a5cc09 qa/static-scheduler-20261110/baseline.log
9a66018a63a7066c1d7882b714a3a945287ca639 qa/static-scheduler-20261110/final-targeted.log
3d11194edd12339564c9b8e50b7eaa6c37a1ccaa tests/oauth-google/evidence/gmail-legacy-before-history/run.txt
247b36b8519feffcb9b63837e8f15dac8e0ba7b8 tests/oauth-google/evidence/handler-before.txt
2335090dcf3e859bfac2671e3dab350576d0344d tests/oauth-google/evidence/scope-before.txt
ad8d62f7ed5df3c1ec512f7b417fdeba91621483 qa/iao-release-qualification-20261123/gitnexus-baseline-cached.log
f704d737230abf3205ec196c735132820f7bbe48 qa/iao-release-qualification-20261123/gitnexus-final-index.log
637a399bab76a2d5b25fef99794ad24448df0ffd qa/iao-release-qualification-20261123/profiles/model-revision-before-test.txt
55246ae3da84de95a7333206ae1d9ade56c0be8f qa/iao-release-qualification-20261123/profiles/model-revision-typecheck.log
6dbf23e38bb494e4e4acab045e8e0a081f226a08 qa/iao-release-qualification-20261123/release/cli-green.log
78e9a90ee0be06942c5471ca9a6d3271524f7604 qa/iao-release-qualification-20261123/release/cli-red.log
37d345c6d8063bf8214ec241f07689de18ec299e qa/iao-release-qualification-20261123/release/existing-readiness.log
55246ae3da84de95a7333206ae1d9ade56c0be8f qa/iao-release-qualification-20261123/release/typecheck-after.log
55246ae3da84de95a7333206ae1d9ade56c0be8f qa/iao-release-qualification-20261123/release/typecheck-before.log
19d6618bdd08c543b5a101755910791a584b5885 qa/iao-release-qualification-20261123/root-typecheck.log
ca0f3efc7e91c3ab988d911a3d248452edf9d325 qa/iao-release-qualification-20261123/ui/browser-revision-red.log
0609db8e46deebfe0e9d4ca2f3680fafa6360284 qa/iao-release-qualification-20261123/ui/client-and-components-green.log
3af933dccbb08156e6687b5e7678732a67208a7b qa/iao-release-qualification-20261123/ui/client-revision-red.log
b41156179fab3cc576894403cfb2a045cf6e3648 qa/iao-release-qualification-20261123/ui/component-baseline.log
ARCHIVED_QA
printf 'Rechecking all changes except %d byte-identical archived QA blobs.\n' "$((${#paths[@]} - 1))"
git diff --check "$base" "$head" -- "${paths[@]}"
