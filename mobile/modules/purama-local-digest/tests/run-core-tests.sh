#!/usr/bin/env bash
set -euo pipefail

suite="${1:---all}"
case "$suite" in --all|--java|--swift) ;; *) printf '%s\n' 'Usage: bash tests/run-core-tests.sh [--all|--java|--swift]' >&2; exit 2 ;; esac
module_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
digest_build_dir="$(mktemp -d "${TMPDIR:-/tmp}/purama-local-digest-tests.XXXXXX")"
trap 'rm -rf -- "$digest_build_dir"' EXIT

if [[ "$suite" != '--swift' ]]; then
  javac_bin="${DIGEST_JAVAC_BIN:-javac}"
  java_bin="${DIGEST_JAVA_BIN:-java}"
  "$javac_bin" -d "$digest_build_dir/java" \
    "$module_root/android/src/main/java/expo/modules/puramalocaldigest/Sha256Core.java" \
    "$module_root/tests/Sha256CoreTest.java"
  "$java_bin" -cp "$digest_build_dir/java" expo.modules.puramalocaldigest.Sha256CoreTest
fi

if [[ "$suite" != '--java' ]]; then
  swiftc_bin="${DIGEST_SWIFTC_BIN:-swiftc}"
  swift_args=(-swift-version 5)
  if [[ -n "${DIGEST_SWIFT_SDK:-}" ]]; then
    swift_args+=(-sdk "$DIGEST_SWIFT_SDK")
  elif command -v xcrun >/dev/null 2>&1; then
    swift_args+=(-sdk "$(xcrun --sdk macosx --show-sdk-path)")
  fi
  "$swiftc_bin" "${swift_args[@]}" \
    "$module_root/apple/Sha256Core.swift" "$module_root/tests/Sha256CoreTests.swift" \
    -o "$digest_build_dir/swift-tests"
  "$digest_build_dir/swift-tests"
fi
