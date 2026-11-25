#!/usr/bin/env bash
# Early network gate for a disposable API-35 CI emulator. No APK or model is run.
set -Eeuo pipefail

if [[ "${PURAMA_QA_NETWORK_BOUNDED:-}" != "1" ]]; then
  export PURAMA_QA_NETWORK_BOUNDED=1
  exec timeout --signal=TERM --kill-after=10s 200s bash "$0" "$@"
fi

PURAMA_QA_NETWORK_DIR="${PURAMA_ANDROID_NETWORK_QA_DIR:-$PWD/qa/android-network-preflight}"
PURAMA_QA_NETWORK_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PURAMA_QA_NETWORK_SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
mkdir -p "$PURAMA_QA_NETWORK_DIR"
git -C "$PURAMA_QA_NETWORK_SCRIPT_DIR/.." rev-parse HEAD HEAD^{tree} > "$PURAMA_QA_NETWORK_DIR/checkout.txt"
[[ -n "$PURAMA_QA_NETWORK_SDK" ]] || { echo "Android SDK location unavailable" >&2; exit 2; }
timeout --signal=TERM 5s "$PURAMA_QA_NETWORK_SDK/emulator/emulator" -version \
  > "$PURAMA_QA_NETWORK_DIR/emulator-version.txt" 2>&1
cp "$PURAMA_QA_NETWORK_SDK/system-images/android-35/google_apis/x86_64/source.properties" \
  "$PURAMA_QA_NETWORK_DIR/system-image-source.properties"
PURAMA_QA_NETWORK_RUN_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
printf '%s\n' "$PURAMA_QA_NETWORK_RUN_ID" > "$PURAMA_QA_NETWORK_DIR/run-id.txt"

PURAMA_QA_NETWORK_RESULT=0
python3 "$PURAMA_QA_NETWORK_SCRIPT_DIR/prepare-android-offline.py" \
  --artifact-dir "$PURAMA_QA_NETWORK_DIR" --run-id "$PURAMA_QA_NETWORK_RUN_ID" || PURAMA_QA_NETWORK_RESULT=$?
if [[ "$PURAMA_QA_NETWORK_RESULT" == "0" ]]; then
  python3 "$PURAMA_QA_NETWORK_SCRIPT_DIR/wait-for-android-offline.py" \
    --artifact-dir "$PURAMA_QA_NETWORK_DIR" --run-id "$PURAMA_QA_NETWORK_RUN_ID" \
    --phase before-restart || PURAMA_QA_NETWORK_RESULT=$?
fi

# Keep the stabilized phone/subscription state even when the observer refuses it.
# The second receipt never overwrites the initial preparation or changes radios.
PURAMA_QA_NETWORK_INSPECTION_RESULT=0
python3 "$PURAMA_QA_NETWORK_SCRIPT_DIR/prepare-android-offline.py" --inspect-only \
  --artifact-dir "$PURAMA_QA_NETWORK_DIR/final-state" --run-id "$PURAMA_QA_NETWORK_RUN_ID" \
  || PURAMA_QA_NETWORK_INSPECTION_RESULT=$?
if [[ "$PURAMA_QA_NETWORK_RESULT" != "0" ]]; then exit "$PURAMA_QA_NETWORK_RESULT"; fi
exit "$PURAMA_QA_NETWORK_INSPECTION_RESULT"
