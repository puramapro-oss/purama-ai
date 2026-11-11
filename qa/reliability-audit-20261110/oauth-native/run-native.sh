#!/usr/bin/env bash
set -euo pipefail

oauth_native_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
oauth_native_pg_bin="${PG_BIN:-}"

if [[ -z "$oauth_native_pg_bin" ]]; then
  oauth_native_pg_bin="$(python3 - <<'PY'
import os
from pathlib import Path
import shutil
import subprocess

candidates = []
postgres = shutil.which("postgres")
if postgres:
    candidates.append(Path(postgres).resolve().parent)
pg_config = shutil.which("pg_config")
if pg_config:
    try:
        result = subprocess.run([pg_config, "--bindir"], capture_output=True, text=True, timeout=3)
        if result.returncode == 0:
            candidates.append(Path(result.stdout.strip()))
    except subprocess.TimeoutExpired:
        pass
candidates.extend(sorted(Path("/usr/lib/postgresql").glob("*/bin"), key=lambda path: int(path.parent.name) if path.parent.name.isdigit() else 0, reverse=True))
candidates.extend([Path("/opt/homebrew/opt/postgresql@18/bin"), Path("/opt/homebrew/opt/postgresql/bin"), Path("/usr/local/pgsql/bin")])
for candidate in candidates:
    if all((candidate / name).is_file() and os.access(candidate / name, os.X_OK) for name in ("initdb", "pg_ctl", "psql", "postgres")):
        print(candidate)
        break
else:
    raise SystemExit("PostgreSQL binaries unavailable: set PG_BIN to a complete installed PostgreSQL bin directory. No existing database will be used.")
PY
)"
fi

for oauth_native_binary in initdb pg_ctl psql postgres; do
  if [[ ! -x "$oauth_native_pg_bin/$oauth_native_binary" ]]; then
    printf 'Missing executable: %s/%s\n' "$oauth_native_pg_bin" "$oauth_native_binary" >&2
    exit 2
  fi
done

"$oauth_native_pg_bin/postgres" --version
"$oauth_native_pg_bin/psql" --version
exec python3 "$oauth_native_script_dir/verify_native.py" --pg-bin "$oauth_native_pg_bin" "$@"
