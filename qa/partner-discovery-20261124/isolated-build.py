#!/usr/bin/env python3
"""Optional isolated build receipt. No server, deployment, secret or published port.

Requires an already installed official Node 24 Docker image, public Git access,
and a frozen overlay directory plus JSON {base_commit, files:{path:{sha256}}}.
This helper has been syntax-checked; remote execution is a separate receipt.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import threading
import time
import uuid


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--task-dir", required=True)
    parser.add_argument("--overlay-dir", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--node-image", required=True,
                        help="An existing official Node image; never pulled")
    args = parser.parse_args()
    task = Path(args.task_dir)
    overlay = Path(args.overlay_dir).resolve(strict=True)
    manifest = json.loads(Path(args.manifest).read_text())
    base = manifest["base_commit"]
    if not re.fullmatch(r"[0-9a-f]{40}", base):
        raise ValueError("An exact base commit is required")
    if (not task.is_absolute() or os.path.lexists(task)
            or not task.parent.is_dir() or task.parent.is_symlink()
            or any(char in str(task) for char in ",\r\n")):
        raise ValueError("Use a new absolute task directory under an existing parent")
    if task.parent.stat().st_uid not in (0, os.getuid()):
        raise PermissionError("Unexpected parent ownership")
    for ancestor in task.parent.parents:
        if ancestor.is_symlink():
            raise PermissionError("Symlink ancestor refused")
    available = re.search(r"^MemAvailable:\s+(\d+)\s+kB$", Path("/proc/meminfo").read_text(), re.M)
    if not available or int(available[1]) * 1024 < 4 * 1024**3:
        raise RuntimeError("Less than 4 GiB of memory is currently available")
    if shutil.disk_usage(task.parent).free < 6 * 1024**3:
        raise RuntimeError("Less than 6 GiB of disk space is currently available")
    claim = uuid.uuid4().hex
    task.mkdir(mode=0o700)
    (task / "owner.json").write_text(json.dumps({
        "claim": claim, "uid": os.getuid(), "purpose": "PURAMA isolated build",
        "created_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }, indent=2))
    logs = task / "logs"
    logs.mkdir()
    source = task / "source"
    clean_env = {"PATH": "/usr/local/bin:/usr/bin:/bin",
                 "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                 "GIT_TERMINAL_PROMPT": "0"}
    receipt = {"status": "RUNNING", "base_commit": base, "commands": [],
               "deployment": False, "ports_published": False,
               "host_credentials_injected": False, "model_downloads": False,
               "limits": {"cpus": 1, "memory_bytes": 3 * 1024**3,
                          "build_timeout_seconds": 480, "log_bytes_per_phase": 8 * 1024**2}}
    containers = []

    def run(label, argv, timeout, cwd=None):
        log = logs / (label + ".log")
        total = 0
        kept = 0
        started = time.monotonic()
        process = subprocess.Popen(argv, cwd=cwd, env=clean_env,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   start_new_session=True)

        def consume():
            nonlocal total, kept
            with log.open("wb") as output:
                while chunk := process.stdout.read(65536):
                    total += len(chunk)
                    selected = chunk[:max(0, 8 * 1024**2 - kept)]
                    output.write(selected)
                    kept += len(selected)

        reader = threading.Thread(target=consume, daemon=True)
        reader.start()
        timed_out = False
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=3)
            code = 124
        reader.join(timeout=3)
        row = {"phase": label, "exit_code": code, "timed_out": timed_out,
               "seconds": round(time.monotonic() - started, 3),
               "log": "logs/" + log.name, "log_sha256": digest(log),
               "observed_output_bytes": total, "kept_output_bytes": kept,
               "truncated": total > kept, "reader_closed": not reader.is_alive()}
        receipt["commands"].append(row)
        if code or reader.is_alive():
            raise RuntimeError("Phase failed: " + label)
        return log.read_text(errors="replace").strip()

    try:
        image_data = run("image", ["docker", "image", "inspect", "--format",
            '{"id":{{json .Id}},"tags":{{json .RepoTags}},"arch":{{json .Architecture}},"os":{{json .Os}}}',
            args.node_image], 20)
        image = json.loads(image_data)
        if not any(tag.startswith(("node:", "docker.io/library/node:")) for tag in image.get("tags") or []):
            raise ValueError("Use an already installed official Node image")
        receipt["image"] = image
        run("git-init", ["git", "init", "--quiet", str(source)], 20)
        run("git-remote", ["git", "-C", str(source), "remote", "add", "origin",
                         "https://github.com/puramapro-oss/purama-ai.git"], 20)
        run("git-fetch", ["git", "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null",
                        "-C", str(source), "fetch", "--depth=1", "origin", base], 120)
        run("git-checkout", ["git", "-c", "core.hooksPath=/dev/null",
                           "-C", str(source), "checkout", "--quiet", "--detach", base], 30)
        if run("base", ["git", "-C", str(source), "rev-parse", "HEAD"], 15) != base:
            raise RuntimeError("Base mismatch")
        for relative, record in manifest["files"].items():
            rel = Path(relative)
            if rel.is_absolute() or ".." in rel.parts or ".git" in rel.parts or any(
                    part.startswith(".env") for part in rel.parts):
                raise ValueError("Invalid overlay path")
            original = overlay / rel
            target = source / rel
            if (not original.is_file() or original.is_symlink()
                    or not original.resolve().is_relative_to(overlay)
                    or not target.resolve().is_relative_to(source.resolve())
                    or digest(original) != record["sha256"]):
                raise ValueError("Invalid overlay identity: " + relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, target)
        # Public example templates are allowed; no operational environment file.
        if any(path.name.startswith(".env") and path.name != ".env.example"
               for path in source.rglob(".env*") if ".git" not in path.parts):
            raise ValueError("Operational environment file refused")
        tracked = run("tracked", ["git", "-C", str(source), "ls-files"], 15).splitlines()
        names = sorted(set(tracked) | set(manifest["files"]))
        if any((source / name).is_symlink() for name in names):
            raise ValueError("Source symlink requires a separate reviewed manifest")
        before = {name: digest(source / name) for name in names}
        (task / "source-manifest.json").write_text(json.dumps(before, sort_keys=True, indent=2))
        receipt["source_manifest_sha256"] = digest(task / "source-manifest.json")
        receipt["overlay"] = manifest["files"]
        receipt["package_lock_sha256"] = digest(source / "package-lock.json")
        uid, gid = (1000, 1000) if os.getuid() == 0 else (os.getuid(), os.getgid())
        if os.getuid() == 0:
            for path in [source, *source.rglob("*")]:
                os.chown(path, uid, gid, follow_symlinks=False)
        common = ["docker", "run", "--rm", "--pull=never", "--init",
                  "--cpus=1", "--memory=3g", "--memory-swap=3g", "--pids-limit=256",
                  "--cap-drop=ALL", "--security-opt=no-new-privileges",
                  "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
                  "--user", str(uid) + ":" + str(gid),
                  "--label", "purama.qa.claim=" + claim,
                  "--mount", "type=bind,src=" + str(source) + ",dst=/workspace",
                  "--workdir", "/workspace", "--entrypoint", "/bin/sh",
                  "--env", "CI=1", "--env", "GOMAXPROCS=1", "--env", "UV_THREADPOOL_SIZE=2",
                  "--env", "npm_config_cache=/tmp/npm-cache",
                  "--env", "npm_config_userconfig=/dev/null",
                  "--env", "NODE_OPTIONS=--max-old-space-size=2048 --max-semi-space-size=4"]
        for phase, network, command, timeout in [
            ("install", "bridge",
             "node -e 'if(process.versions.node.split(\".\")[0]!==\"24\")process.exit(2)' && node --version && npm --version && npm ci --no-audit --no-fund", 300),
            ("build", "none", "npm run build", 480),
        ]:
            name = "purama-qa-" + claim + "-" + phase
            containers.append(name)
            run(phase, common + ["--name", name, "--network", network,
                                image["id"], "-c", command], timeout)
        after = {name: digest(source / name) for name in names}
        if before != after:
            raise RuntimeError("Tracked source or lock changed during qualification")
        artifacts = {str(path.relative_to(source / "dist")):
                     {"sha256": digest(path), "bytes": path.stat().st_size}
                     for path in (source / "dist").rglob("*") if path.is_file()}
        if not artifacts or not (source / "dist/index.html").is_file():
            raise RuntimeError("Build artifact missing")
        (task / "dist-manifest.json").write_text(json.dumps(artifacts, sort_keys=True, indent=2))
        receipt.update({"status": "PASS", "source_unchanged": True,
                        "artifact_count": len(artifacts),
                        "dist_manifest_sha256": digest(task / "dist-manifest.json")})
    except Exception as error:
        receipt["status"] = "FAILED"
        receipt["failure_class"] = type(error).__name__
        # Keep provider output in bounded phase logs; no host environment dump.
    finally:
        cleanup = []
        for name in containers:
            try:
                result = subprocess.run(["docker", "inspect", "--format",
                    '{{index .Config.Labels "purama.qa.claim"}}', name],
                    capture_output=True, text=True, timeout=15, env=clean_env)
                if result.returncode == 0 and result.stdout.strip() == claim:
                    removed = subprocess.run(["docker", "rm", "--force", name],
                        capture_output=True, text=True, timeout=15, env=clean_env)
                    cleanup.append({"owned_container_removed": removed.returncode == 0})
                else:
                    cleanup.append({"already_absent": "No such" in result.stderr,
                                    "foreign_container_untouched": result.returncode == 0})
            except (OSError, subprocess.TimeoutExpired):
                cleanup.append({"cleanup_unconfirmed": True})
        receipt["cleanup"] = cleanup
        if any(not (row.get("owned_container_removed") or row.get("already_absent")) for row in cleanup):
            receipt["cleanup_status"] = "PARTIAL"
            if receipt["status"] == "PASS":
                receipt["status"] = "PARTIAL"
        receipt["completed_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (task / "receipt.json").write_text(json.dumps(receipt, sort_keys=True, indent=2))
        print(json.dumps({"status": receipt["status"], "receipt": str(task / "receipt.json")}))
    return 0 if receipt["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
