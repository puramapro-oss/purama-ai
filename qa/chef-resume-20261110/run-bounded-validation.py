"""Run every KARTA test file once, in successive Vitest processes.

Uses the repository's existing assertions/timeouts. Produces a complete file
inventory, individual command receipts, JSON-derived totals and raw console log.
Raw Vitest JSON files are retained outside the repository as intermediate data.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def memory_available():
    try:
        return next(line for line in Path('/proc/meminfo').read_text().splitlines()
                    if line.startswith('MemAvailable:'))
    except (OSError, StopIteration):
        return None


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--node', required=True)
parser.add_argument('--timeout', type=int, default=120)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
karta = root / 'karta'
out = Path(__file__).resolve().parent / 'bounded'
out.mkdir(exist_ok=True)
if (out / 'summary.json').exists():
    raise SystemExit('Refusing to overwrite an existing validation campaign')
raw = Path(tempfile.mkdtemp(prefix='chef-resume-vitest-'))
files = sorted(karta.glob('test/**/*.test.ts'))
inventory = {str(p.relative_to(karta)): digest(p) for p in files}
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
supervisor = karta / 'src/chef/supervisor.ts'
state = {
    'started_at': datetime.now(timezone.utc).isoformat(),
    'base_head': head,
    'node': args.node,
    'node_version': subprocess.check_output([args.node, '--version'], text=True).strip(),
    'supervisor_sha256_before': digest(supervisor),
    'test_inventory_sha256': inventory,
    'expected_files': len(files),
    'process_parallelism': 1,
    'worker_parallelism': 1,
    'test_timeouts_modified': False,
    'memory_available_before': memory_available(),
    'intermediate_raw_reports': str(raw),
    'results': [],
    'complete': False,
    'success': False,
}
start = time.monotonic()


def save():
    temporary = out / 'summary.tmp'
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(out / 'summary.json')


save()
with (out / 'combined.log').open('w') as combined:
    for number, file in enumerate(files, 1):
        relative = str(file.relative_to(karta))
        raw_json = raw / f'{number:03}.json'
        raw_log = raw / f'{number:03}.log'
        command = [args.node, 'node_modules/vitest/vitest.mjs', 'run', relative,
                   '--maxWorkers=1', '--reporter=default', '--reporter=json',
                   f'--outputFile={raw_json}']
        result = {
            'file': relative, 'command': command,
            'started_at': datetime.now(timezone.utc).isoformat(),
            'exit_code': None, 'timed_out': False, 'interrupted': False,
        }
        t0 = time.monotonic()
        child = None
        with raw_log.open('w') as log:
            try:
                child = subprocess.Popen(command, cwd=karta, stdout=log,
                                         stderr=subprocess.STDOUT, start_new_session=True)
                result['exit_code'] = child.wait(timeout=args.timeout)
            except subprocess.TimeoutExpired:
                result['timed_out'] = True
            except KeyboardInterrupt:
                result['interrupted'] = True
            except OSError as error:
                result['launch_error'] = str(error)
            finally:
                if child is not None and child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait()
                    result['exit_code'] = child.returncode
        result['elapsed_seconds'] = round(time.monotonic() - t0, 3)
        result['console_sha256'] = digest(raw_log)
        combined.write(json.dumps({'file': relative, 'command': command}) + '\n')
        combined.write(raw_log.read_text(errors='replace'))
        combined.write('\n')
        combined.flush()
        result['report_present'] = raw_json.exists()
        if raw_json.exists():
            report = json.loads(raw_json.read_text())
            result['raw_report_sha256'] = digest(raw_json)
            result['report_success'] = report.get('success')
            result['reported_total_tests'] = report.get('numTotalTests')
            result['reported_passed_tests'] = report.get('numPassedTests')
            result['reported_failed_tests'] = report.get('numFailedTests')
            result['reported_pending_tests'] = report.get('numPendingTests')
            result['reported_todo_tests'] = report.get('numTodoTests')
            result['reported_files'] = [str(Path(suite['name']).relative_to(karta))
                                        for suite in report.get('testResults', [])]
            assertions = [a for suite in report.get('testResults', [])
                          for a in suite.get('assertionResults', [])]
            result['assertion_status_counts'] = dict(Counter(a['status'] for a in assertions))
            result['assertions'] = [
                {'name': a.get('fullName', a.get('title')), 'status': a['status'],
                 **({'failureMessages': a['failureMessages']} if a.get('failureMessages') else {})}
                for a in assertions
            ]
            result['success'] = (
                result['exit_code'] == 0 and not result['timed_out']
                and not result['interrupted'] and report.get('success') is True
                and result['reported_files'] == [relative]
                and len(assertions) == report.get('numTotalTests')
                and all(a['status'] == 'passed' for a in assertions)
                and report.get('numFailedTests') == 0
                and report.get('numPendingTests') == 0
                and report.get('numTodoTests') == 0
            )
        else:
            result['success'] = False
        state['results'].append(result)
        save()
        print(json.dumps({'file': relative, 'number': number, 'of': len(files),
                          'passed': result.get('reported_passed_tests'),
                          'success': result['success'],
                          'seconds': result['elapsed_seconds']}), flush=True)
        if result['interrupted']:
            break

actual = [r['file'] for r in state['results']]
state['coverage'] = {
    'missing_files': sorted(set(inventory) - set(actual)),
    'unexpected_files': sorted(set(actual) - set(inventory)),
    'duplicated_files': sorted(f for f, n in Counter(actual).items() if n != 1),
    'test_files_changed_during_run': [f for f, sha in inventory.items()
                                    if digest(karta / f) != sha],
}
state['supervisor_sha256_after'] = digest(supervisor)
state['total_tests'] = sum(r.get('reported_total_tests', 0) for r in state['results'])
state['passed_tests'] = sum(r.get('reported_passed_tests', 0) for r in state['results'])
state['failed_tests'] = sum(r.get('reported_failed_tests', 0) for r in state['results'])
state['pending_tests'] = sum(r.get('reported_pending_tests', 0) for r in state['results'])
state['todo_tests'] = sum(r.get('reported_todo_tests', 0) for r in state['results'])
state['complete'] = len(actual) == len(inventory)
state['success'] = (
    state['complete'] and all(r['success'] for r in state['results'])
    and not any(state['coverage'].values())
    and state['supervisor_sha256_before'] == state['supervisor_sha256_after']
)
state['elapsed_seconds'] = round(time.monotonic() - start, 3)
state['finished_at'] = datetime.now(timezone.utc).isoformat()
state['memory_available_after'] = memory_available()
save()
print(json.dumps({k: v for k, v in state.items()
                  if k not in ['results', 'test_inventory_sha256']}), flush=True)
raise SystemExit(0 if state['success'] else 1)
