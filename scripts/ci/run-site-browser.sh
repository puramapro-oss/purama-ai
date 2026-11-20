#!/usr/bin/env bash
set -euo pipefail

# Keep the existing Node runtime and test commands. Only browser binaries and
# their OS dependencies come from the matching official Playwright image.
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_dir"
playwright_version='1.64.1'
image="mcr.microsoft.com/playwright:v${playwright_version}-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f"

node_dir="$(PURAMA_PLAYWRIGHT_VERSION="$playwright_version" node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'

assert.equal(process.platform, 'linux', 'The browser image requires the Linux CI runner')
assert.equal(process.arch, 'x64', 'The browser image is selected for the x64 CI runner')
assert.equal(process.versions.node.split('.')[0], '22', 'Keep the site job Node 22 runtime')
const expected = process.env.PURAMA_PLAYWRIGHT_VERSION
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
assert.equal(manifest.devDependencies['@playwright/test'], expected, 'Update the image with the package version')
for (const name of ['@playwright/test', 'playwright', 'playwright-core']) {
  assert.equal(lock.packages[`node_modules/${name}`].version, expected, `${name}: lockfile/image mismatch`)
  const installed = JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8'))
  assert.equal(installed.version, expected, `${name}: installed version mismatch`)
}
console.log(dirname(dirname(process.execPath)))
NODE
)"

runner_uid="$(id -u)"
runner_gid="$(id -g)"
if [[ "$runner_uid" == '0' ]]; then
  printf '%s\n' 'Browser CI must run as the existing non-root runner user.' >&2
  exit 1
fi
if [[ $# -eq 0 ]]; then
  printf '%s\n' 'Usage: run-site-browser.sh --prepare | COMMAND [ARGUMENT ...]' >&2
  exit 64
fi
if [[ "$1" == '--prepare' ]]; then
  [[ $# -eq 1 ]] || exit 64
  exec docker pull --platform linux/amd64 "$image"
fi

# Each suite keeps loopback access to its own local fixtures. There are no
# provider credentials or host browser overrides passed into this container.
# Social browser tests stay on the host with their existing sandboxed Chrome.
exec docker run --rm --init --pull=never --platform linux/amd64 \
  --network=none --shm-size=1g \
  --user "$runner_uid:$runner_gid" \
  --mount "type=bind,source=$repo_dir,target=/work" \
  --mount "type=bind,source=$node_dir,target=/opt/purama-node,readonly" \
  --tmpfs "/tmp/purama-browser-home:rw,nosuid,nodev,size=256m,mode=700,uid=$runner_uid,gid=$runner_gid" \
  --workdir /work \
  --env 'PATH=/opt/purama-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
  --env 'HOME=/tmp/purama-browser-home' \
  --env 'CI=true' \
  --env 'npm_config_cache=/tmp/purama-browser-npm-cache' \
  --env 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright' \
  --env 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1' \
  --entrypoint /usr/bin/env \
  "$image" "$@"
