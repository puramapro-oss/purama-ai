#!/usr/bin/env bash
# Run only against a disposable Android emulator and an already installed APK
# containing a bundled JS build with EXPO_PUBLIC_PURAMA_OFFLINE_QUALIFICATION=1.
# Building/installing the APK belongs to the caller's existing CI workflow.
set -Eeuo pipefail

if [[ "${PURAMA_QA_BOUNDED:-}" != "1" ]]; then
  export PURAMA_QA_BOUNDED=1
  # Preparation (600 s), cold offline verification/inference (at most 840 s),
  # and bounded ADB/cleanup overhead fit inside one finite scenario deadline.
  exec timeout --signal=TERM --kill-after=15s 1600s bash "$0" "$@"
fi

PURAMA_QA_PACKAGE="${PURAMA_OFFLINE_QA_PACKAGE:-dev.purama.purama_ai}"
PURAMA_QA_ARTIFACTS="${PURAMA_OFFLINE_QA_DIR:-$PWD/qa/offline-native}"
PURAMA_QA_URI="purama-ai://iao-qualification"
[[ "$PURAMA_QA_PACKAGE" =~ ^[a-zA-Z0-9_.]+$ ]] || { echo "Invalid QA package" >&2; exit 2; }
mkdir -p "$PURAMA_QA_ARTIFACTS"

PURAMA_QA_ADB=(adb)
if [[ -n "${ANDROID_SERIAL:-}" ]]; then PURAMA_QA_ADB+=(-s "$ANDROID_SERIAL"); fi
qa_adb() { timeout --signal=TERM 25s "${PURAMA_QA_ADB[@]}" "$@"; }

PURAMA_QA_LOG_PID=""
PURAMA_QA_NETWORK_CHANGED=0
PURAMA_QA_RESULT_WRITTEN=0
PURAMA_QA_INITIAL_AIRPLANE=0
PURAMA_QA_INITIAL_WIFI=1
PURAMA_QA_INITIAL_DATA=1

qa_cleanup() {
  local outcome=$?
  set +e
  if [[ -n "$PURAMA_QA_LOG_PID" ]]; then kill "$PURAMA_QA_LOG_PID" 2>/dev/null; wait "$PURAMA_QA_LOG_PID" 2>/dev/null; fi
  if [[ "$PURAMA_QA_RESULT_WRITTEN" != "1" ]]; then
    python3 - "$PURAMA_QA_ARTIFACTS/qualification.json" "$outcome" <<'PY'
import json,sys
with open(sys.argv[1], 'w') as stream:
    json.dump({'schema':1,'status':'FAIL','phase':'harness','exitCode':int(sys.argv[2]),
      'note':'No complete native offline receipt was verified. Inspect bounded logcat evidence.'},stream,indent=2)
PY
  fi
  if [[ "$PURAMA_QA_NETWORK_CHANGED" == "1" ]]; then
    qa_adb shell settings put global airplane_mode_on "$PURAMA_QA_INITIAL_AIRPLANE" >/dev/null 2>&1
    if [[ "$PURAMA_QA_INITIAL_AIRPLANE" == "1" ]]; then
      qa_adb shell cmd connectivity airplane-mode enable >/dev/null 2>&1
    else qa_adb shell cmd connectivity airplane-mode disable >/dev/null 2>&1; fi
    if [[ "$PURAMA_QA_INITIAL_WIFI" == "1" ]]; then qa_adb shell svc wifi enable >/dev/null 2>&1; fi
    if [[ "$PURAMA_QA_INITIAL_DATA" == "1" ]]; then qa_adb shell svc data enable >/dev/null 2>&1; fi
  fi
  exit "$outcome"
}
trap qa_cleanup EXIT
trap 'exit 124' TERM

qa_adb wait-for-device
[[ "$(qa_adb shell getprop ro.kernel.qemu | tr -d '\r')" == "1" ]] || {
  echo "Qualification refuses non-emulator devices; fixture reset is destructive." >&2; exit 2;
}
qa_adb shell pm path "$PURAMA_QA_PACKAGE" >"$PURAMA_QA_ARTIFACTS/package-path.txt"
qa_adb shell getprop ro.build.version.sdk >"$PURAMA_QA_ARTIFACTS/android-api.txt"
qa_adb shell getprop ro.product.cpu.abi >"$PURAMA_QA_ARTIFACTS/android-abi.txt"
qa_adb shell cat /proc/meminfo >"$PURAMA_QA_ARTIFACTS/android-memory.txt"

PURAMA_QA_INITIAL_AIRPLANE="$(qa_adb shell settings get global airplane_mode_on | tr -d '\r')"
PURAMA_QA_INITIAL_WIFI="$(qa_adb shell settings get global wifi_on | tr -d '\r')"
PURAMA_QA_INITIAL_DATA="$(qa_adb shell settings get global mobile_data | tr -d '\r')"
PURAMA_QA_NETWORK_CHANGED=1
qa_adb shell cmd connectivity airplane-mode disable
qa_adb shell settings put global airplane_mode_on 0
qa_adb shell svc wifi enable
qa_adb shell svc data enable

# A fresh emulator fixture installation is required. No production account login
# or cloud credentials are created or injected by this script.
qa_adb shell am force-stop "$PURAMA_QA_PACKAGE"
qa_adb shell pm clear "$PURAMA_QA_PACKAGE" >"$PURAMA_QA_ARTIFACTS/fixture-reset.txt"
qa_adb reverse --remove-all
qa_adb logcat -c
"${PURAMA_QA_ADB[@]}" logcat -v brief ReactNativeJS:I AndroidRuntime:E libc:F '*:S' >"$PURAMA_QA_ARTIFACTS/logcat.txt" 2>&1 &
PURAMA_QA_LOG_PID=$!

qa_wait_phase() {
  local phase="$1"
  local budget="$2"
  local deadline=$((SECONDS + budget))
  local code=0
  while (( SECONDS < deadline )); do
    if python3 - "$PURAMA_QA_ARTIFACTS/logcat.txt" "$phase" "$PURAMA_QA_ARTIFACTS/$phase.json" <<'PY'
import json,os,sys
with open(sys.argv[1], 'rb') as stream:
    stream.seek(0,os.SEEK_END); stream.seek(max(0,stream.tell()-4*1024*1024))
    data=stream.read().decode('utf-8','replace')
marker='PURAMA_OFFLINE_QUALIFICATION:'
for line in data.splitlines():
    if marker not in line: continue
    try: receipt=json.loads(line.split(marker,1)[1].strip())
    except (ValueError,TypeError): continue
    if receipt.get('schema') != 1: continue
    if receipt.get('phase') == 'failed' or receipt.get('status') == 'FAIL':
        with open(sys.argv[3], 'w') as stream: json.dump(receipt,stream,indent=2)
        print('Native qualification failed:',receipt.get('code','unknown'),flush=True)
        sys.exit(20)
    if receipt.get('phase') == sys.argv[2] and receipt.get('status') == 'PASS':
        with open(sys.argv[3], 'w') as stream: json.dump(receipt,stream,indent=2)
        print('Observed native phase:',sys.argv[2],flush=True)
        sys.exit(0)
sys.exit(1)
PY
    then return 0
    else code=$?; if [[ "$code" != "1" ]]; then return "$code"; fi; fi
    if ! kill -0 "$PURAMA_QA_LOG_PID" 2>/dev/null; then echo "Logcat collector stopped" >&2; return 21; fi
    sleep 1
  done
  echo "Timed out waiting for native phase: $phase" >&2
  return 124
}

qa_adb shell am start -W -a android.intent.action.VIEW -d "$PURAMA_QA_URI" "$PURAMA_QA_PACKAGE" >"$PURAMA_QA_ARTIFACTS/launch-prepared.txt"
qa_wait_phase prepared 600
qa_adb exec-out screencap -p >"$PURAMA_QA_ARTIFACTS/prepared.png"

qa_adb shell pidof "$PURAMA_QA_PACKAGE" >"$PURAMA_QA_ARTIFACTS/prepared-pid.txt"
qa_adb shell am force-stop "$PURAMA_QA_PACKAGE"
if qa_adb shell pidof "$PURAMA_QA_PACKAGE" >"$PURAMA_QA_ARTIFACTS/stopped-pid.txt"; then
  echo "Application process survived force-stop" >&2; exit 22
else
  PURAMA_QA_PID_STATUS=$?
  [[ "$PURAMA_QA_PID_STATUS" == "1" ]] || { echo "Could not verify process stop" >&2; exit 22; }
fi

qa_adb shell svc wifi disable
qa_adb shell svc data disable
qa_adb shell cmd connectivity airplane-mode enable
qa_adb shell settings put global airplane_mode_on 1
qa_adb reverse --remove-all
qa_adb shell settings get global airplane_mode_on >"$PURAMA_QA_ARTIFACTS/airplane-mode.txt"
qa_adb shell settings get global wifi_on >"$PURAMA_QA_ARTIFACTS/wifi-on.txt"
qa_adb shell settings get global mobile_data >"$PURAMA_QA_ARTIFACTS/mobile-data.txt"
qa_adb shell dumpsys connectivity >"$PURAMA_QA_ARTIFACTS/connectivity-offline.txt"
[[ "$(tr -d '\r\n' <"$PURAMA_QA_ARTIFACTS/airplane-mode.txt")" == "1" ]] || { echo "Airplane mode not active" >&2; exit 23; }
[[ "$(tr -d '\r\n' <"$PURAMA_QA_ARTIFACTS/wifi-on.txt")" == "0" ]] || { echo "Wi-Fi not disabled" >&2; exit 23; }
[[ "$(tr -d '\r\n' <"$PURAMA_QA_ARTIFACTS/mobile-data.txt")" == "0" ]] || { echo "Mobile data not disabled" >&2; exit 23; }

qa_adb shell am start -W -a android.intent.action.VIEW -d "$PURAMA_QA_URI" "$PURAMA_QA_PACKAGE" >"$PURAMA_QA_ARTIFACTS/launch-offline.txt"
qa_wait_phase complete 900
qa_adb exec-out screencap -p >"$PURAMA_QA_ARTIFACTS/offline.png"
qa_adb shell pidof "$PURAMA_QA_PACKAGE" >"$PURAMA_QA_ARTIFACTS/offline-pid.txt"

python3 - "$PURAMA_QA_ARTIFACTS" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]); prepared=json.loads((root/'prepared.json').read_text()); completed=json.loads((root/'complete.json').read_text())
assert prepared['runId'] == completed['runId'], 'Receipts do not belong to one process-restart scenario'
assert prepared['fixtureAccountsOnly'] is True and completed['fixtureAccountsOnly'] is True
assert prepared['backend'] == completed['backend'] == 'llama.rn'
assert prepared['gpu'] is False and completed['gpu'] is False
assert prepared['model'] == completed['model']
assert completed['model']['sha256'] == '9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031'
assert completed['model']['bytes'] == 639446688
assert prepared['nativeOutput'].strip() and completed['nativeOutput'].strip()
assert completed['reportedTotalMemoryBytes'] >= completed['requiredMemoryBytes']
required=['draftRestoredAfterProcessRestart','firstNativeAnswerRestored','pendingAssistantRecoveredAsInterrupted',
 'partialAnswerPreserved','packReverifiedAfterRestart','realOfflineNativeCompletion','offlineAnswerDurable',
 'syncRemainsPending','accountIsolation','previousOwnerFenced','wrongKeyRejected','correctKeyStillReads',
 'noPlaintextFixtureInDatabaseFiles','globalFetchXHRWebSocketBlocked']
assert all(completed['checks'].get(key) is True for key in required)
assert completed['checks']['unexpectedJsNetworkCalls'] == 0
result={'schema':1,'status':'PASS','scenario':'native Android process restart + offline inference + encrypted persistence',
 'prepared':prepared,'offline':completed,
 'adb':{'emulatorOnly':True,'processForceStopped':True,'airplaneMode':True,'wifiDisabled':True,'mobileDataDisabled':True,
        'metroReverseRemoved':True,'api':(root/'android-api.txt').read_text().strip(),'abi':(root/'android-abi.txt').read_text().strip()},
 'limitations':completed['limitations']}
(root/'qualification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print('PASS: real native offline qualification receipts verified.')
PY
PURAMA_QA_RESULT_WRITTEN=1
