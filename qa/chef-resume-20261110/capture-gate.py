import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import subprocess
import time

p=argparse.ArgumentParser()
p.add_argument('--cwd',required=True)
p.add_argument('--log',required=True)
p.add_argument('--timeout',type=int,default=180)
p.add_argument('command',nargs=argparse.REMAINDER)
a=p.parse_args()
cmd=a.command[1:] if a.command[:1]==['--'] else a.command
log=Path(a.log);log.parent.mkdir(parents=True,exist_ok=True)
start=time.monotonic()
r={'command':cmd,'cwd':a.cwd,'started_at':datetime.now(timezone.utc).isoformat(),'timeout_seconds':a.timeout,'timed_out':False,'interrupted':False,'exit_code':None}
child=None
with log.open('w') as out:
    try:
        child=subprocess.Popen(cmd,cwd=a.cwd,stdout=out,stderr=subprocess.STDOUT,start_new_session=True)
        r['exit_code']=child.wait(timeout=a.timeout)
    except subprocess.TimeoutExpired:
        r['timed_out']=True
    except KeyboardInterrupt:
        r['interrupted']=True
    except OSError as error:
        r['launch_error']=str(error);out.write(str(error)+'\n')
    finally:
        if child is not None and child.poll() is None:
            os.killpg(child.pid,signal.SIGTERM)
            try: child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid,signal.SIGKILL);child.wait()
            r['exit_code']=child.returncode
r['elapsed_seconds']=round(time.monotonic()-start,3)
log.with_suffix('.receipt.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps(r),flush=True)
raise SystemExit(130 if r['interrupted'] else 124 if r['timed_out'] else r['exit_code'] if r['exit_code'] is not None else 127)
