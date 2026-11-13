#!/usr/bin/env python3
"""Private integration harness. Uses only the dedicated isolated Hostinger clone.
No production changes, schedules or external messages; credentials remain outside Git.
Stop by creating the private directory's STOP file. All spawned processes are settled.
"""
import os, sys, json, time, socket, secrets, signal, subprocess, tempfile, threading
import urllib.request, urllib.error, urllib.parse
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if os.environ.get("WORKSHOP_QA_ISOLATED_CLONE") != "confirmed":
    raise SystemExit("The dedicated isolated clone must be confirmed before this manual check.")
repo = Path(__file__).resolve().parents[2]
qa = Path(__file__).resolve().parent
node = Path("/Users/matissdornier/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node")
chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
private = Path(tempfile.mkdtemp(prefix="purama-atelier-authenticated-")).resolve()
os.chmod(private, 0o700)
children = []
logs = []
stopping = threading.Event()
def stop(*_):
    stopping.set()
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
def port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
ports = {name: port() for name in ["forward","redis","gateway","edge","api","app"]}
assert len(set(ports.values())) == len(ports)
def load_secret(name):
    path = "/srv/purama-atelier-activation-20261113/secrets/" + name
    p = subprocess.run(["ssh","-o","BatchMode=yes","purama-hostinger","cat",path],
                       capture_output=True,check=True,timeout=15)
    return p.stdout.decode()
def env_parse(text):
    return dict(line.split("=",1) for line in text.splitlines() if "=" in line and not line.startswith("#"))
def save_private(name, content):
    p = private/name
    p.write_text(content)
    os.chmod(p, 0o600)
    return p
def launch(name,args,env=None,cwd=None):
    log=(private/(name+".log")).open("wb")
    logs.append(log)
    p=subprocess.Popen(args,cwd=cwd or repo,env=env,stdout=log,stderr=subprocess.STDOUT,
                       stdin=subprocess.DEVNULL,start_new_session=True)
    children.append((name,p))
    return p
def wait_http(url, headers=None, limit=45):
    end=time.monotonic()+limit
    while time.monotonic()<end and not stopping.is_set():
        try:
            with urllib.request.urlopen(urllib.request.Request(url,headers=headers or {}),timeout=2) as r:
                if r.status==200:return
        except Exception:
            pass
        for _,p in children:
            if p.poll() is not None:raise RuntimeError("A private service exited before readiness")
        stopping.wait(0.4)
    raise RuntimeError("Private HTTP readiness not reached")

gateway = None
exit_code = 0
try:
    credentials=env_parse(load_secret("runtime.env"))
    accounts=json.loads(load_secret("accounts.json"))
    redis_parts=urllib.parse.urlsplit(env_parse(load_secret("redis.env"))["REDIS_URL"])
    launch("tunnel",["ssh","-o","BatchMode=yes","-o","ExitOnForwardFailure=yes",
        "-o","ServerAliveInterval=15","-o","ServerAliveCountMax=3","-N",
        "-L",f"127.0.0.1:{ports['forward']}:10.253.74.5:8000",
        "-L",f"127.0.0.1:{ports['redis']}:{redis_parts.hostname}:{redis_parts.port or 6379}","purama-hostinger"])
    supabase_url=f"http://127.0.0.1:{ports['gateway']}"
    app_url=f"http://127.0.0.1:{ports['app']}"
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def proxy(self):
            if not self.path.startswith(("/auth/v1/","/rest/v1/","/functions/v1/chef-workshop")):
                self.send_error(404);return
            length=int(self.headers.get("content-length","0"))
            if length<0 or length>65536:self.send_error(413);return
            dest=ports["edge"] if self.path.startswith("/functions/") else ports["forward"]
            allowed={"accept","authorization","apikey","content-type","accept-profile","content-profile","prefer","x-client-info","x-supabase-api-version"}
            headers={k:v for k,v in self.headers.items() if k.lower() in allowed}
            body=self.rfile.read(length) if length else None
            req=urllib.request.Request(f"http://127.0.0.1:{dest}"+self.path,data=body,headers=headers,method=self.command)
            try:
                response=urllib.request.urlopen(req,timeout=15)
            except urllib.error.HTTPError as e:
                response=e
            except Exception:
                self.send_error(502);return
            with response:
                data=response.read(6*1024*1024+1)
                if len(data)>6*1024*1024:self.send_error(502);return
                self.send_response(response.status)
                for k,v in response.headers.items():
                    if k.lower() in ["content-type","content-range","x-total-count"]:self.send_header(k,v)
                self.send_header("Access-Control-Allow-Origin",app_url)
                self.send_header("Cache-Control","no-store")
                self.send_header("Content-Length",str(len(data)))
                self.end_headers()
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # The browser may close an in-flight polling request after cancellation.
        do_GET=proxy
        do_POST=proxy
        do_PATCH=proxy
        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin",app_url)
            self.send_header("Access-Control-Allow-Headers","authorization,apikey,content-type,x-client-info,accept-profile,content-profile,x-supabase-api-version,prefer")
            self.send_header("Access-Control-Allow-Methods","GET,POST,PATCH,OPTIONS")
            self.end_headers()
    gateway=ThreadingHTTPServer(("127.0.0.1",ports["gateway"]),Handler)
    threading.Thread(target=gateway.serve_forever,daemon=True).start()
    wait_http(supabase_url+"/auth/v1/health",{"apikey":credentials["SUPABASE_ANON_KEY"]})
    project_id="qa-"+secrets.token_hex(5)
    workdir=private/"project"
    workdir.mkdir(mode=0o700)
    (workdir/"README.md").write_text("Private acceptance fixture. Only index.html may change. No deployment, credentials or external resources.\n")
    for args in [["init","-q"],["-c","user.name=PURAMA verification","-c","user.email=verification@example.invalid","add","README.md"],
                 ["-c","user.name=PURAMA verification","-c","user.email=verification@example.invalid","-c","core.hooksPath=/dev/null","commit","-qm","Seed private workshop verification"]]:
        subprocess.run(["/usr/bin/git","-C",str(workdir),*args],capture_output=True,check=True)
    profiles=[{"name":name,"kind":kind,"command":str(node),"args":[str(qa/"verify-generated.mjs"),chrome],
               "requirementKeys":["PRODUCT","QUALITY"],"timeoutMs":60000}
              for name,kind in [("acceptance","test"),("independent-acceptance","review")]]
    project={"id":project_id,"name":"Atelier de qualification","userIds":[accounts["owner"]["id"]],
        "repo":"qa/"+project_id,"workdir":str(workdir),"allowedPaths":["index.html"],
        "exportPaths":["index.html"],"previewEntry":"index.html","maxParallel":2,
        "tokenBudget":1500000,"estimatedTokensPerTask":300000,
        "codexCommand":"/Users/matissdornier/.local/bin/codex",
        "verificationProfiles":profiles,"implementationProfiles":["acceptance"],"reviewProfiles":["independent-acceptance"]}
    base_env={k:v for k,v in os.environ.items() if k in ["HOME","PATH","TMPDIR","LANG","LC_ALL","TERM"]}
    base_env.update({"SUPABASE_URL":supabase_url,"SUPABASE_SERVICE_ROLE_KEY":credentials["SUPABASE_SERVICE_ROLE_KEY"],
        "SUPABASE_ANON_KEY":credentials["SUPABASE_ANON_KEY"],"KARTA_ADMIN_TOKEN":secrets.token_hex(32),
        "KARTA_PORT":str(ports["api"]),"REDIS_URL":f"redis://:{redis_parts.password}@127.0.0.1:{ports['redis']}",
        "CHEF_WORKSHOP_PROJECTS_JSON":json.dumps([project]),"KARTA_MOCK_CLAUDE":"true",
        "KARTA_INTERNAL_URL":f"http://127.0.0.1:{ports['api']}","WORKSHOP_PRIVATE_EDGE_PORT":str(ports["edge"])})
    launch("api-worker",[str(node),str(qa/"api-runtime.mjs")],base_env)
    wait_http(base_env["KARTA_INTERNAL_URL"]+"/health",limit=60)
    launch("edge",["/opt/homebrew/bin/deno","run","--no-config","--no-lock","--node-modules-dir=manual",
        "--allow-env","--allow-net=127.0.0.1","--allow-read",str(qa/"edge-runner.ts")],base_env)
    vite_env={**base_env,"VITE_SUPABASE_URL":supabase_url,"VITE_SUPABASE_PUBLISHABLE_KEY":credentials["SUPABASE_ANON_KEY"]}
    # Remove server credentials from the frontend dev server environment.
    for k in ["SUPABASE_SERVICE_ROLE_KEY","KARTA_ADMIN_TOKEN","REDIS_URL","CHEF_WORKSHOP_PROJECTS_JSON"]:
        vite_env.pop(k,None)
    launch("frontend",[str(node),"node_modules/vite/bin/vite.js","--host","127.0.0.1","--port",str(ports["app"]),"--strictPort"],vite_env)
    wait_http(app_url+"/login",limit=60)
    config={"origin":app_url,"supabaseUrl":supabase_url,"proxyUrl":supabase_url+"/functions/v1/chef-workshop",
        "anonKey":credentials["SUPABASE_ANON_KEY"],
        "accounts":{k:{"email":v["email"],"password":v["password"]} for k,v in accounts.items()},
        "projectId":project_id,
        "prompt":"Crée uniquement index.html : une page française autonome, responsive, accessible, avec le titre HTML exact Atelier PURAMA. Un compteur visible dans l’élément id=counter commence à 0. Le bouton nommé exactement Ajouter une unité augmente ce compteur de 1 à chaque clic et à l’activation clavier. Aucun appel réseau ni ressource externe. Vérifie les vrais comportements, l’absence d’erreurs JavaScript et le rendu à 320 pixels. Ne modifie pas README.md et ne lance aucune commande git add/commit ; le serveur enregistre la version. Ne publie et ne déploie rien.",
        "timeoutMs":600000,"artifact":{"counterSelector":"#counter","buttonName":"Ajouter une unité"}}
    config_path=save_private("browser-config.json",json.dumps(config))
    save_private("project.json",json.dumps(project))
    public={"privateDirectory":str(private),"configPath":str(config_path),"ports":ports,
        "projectId":project_id,"workdir":str(workdir),"processes":[{"name":n,"pid":p.pid} for n,p in children],
        "ready":True,"isolation":"Dedicated clone and private services only; no production activation"}
    (qa/"private-bootstrap.json").write_text(json.dumps(public,indent=2)+"\n")
    print(json.dumps({"event":"PRIVATE_STACK_READY","configPath":str(config_path),"privateDirectory":str(private)}),flush=True)
    deadline=time.monotonic()+900
    while not stopping.is_set() and not (private/"STOP").exists() and time.monotonic()<deadline:
        if any(p.poll() is not None for _,p in children):raise RuntimeError("Private service stopped unexpectedly")
        stopping.wait(1)
except Exception as error:
    print(json.dumps({"event":"PRIVATE_BOOTSTRAP_FAILED","type":type(error).__name__,"privateDirectory":str(private)}),flush=True)
    exit_code=1
finally:
    # Stop the worker before closing its database transport.
    ordered=sorted(children,key=lambda item:0 if item[0]=="api-worker" else 1 if item[0]!="tunnel" else 2)
    settled=[]
    for name,p in ordered:
        if p.poll() is None:os.killpg(p.pid,signal.SIGTERM)
        try:p.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
        settled.append({"name":name,"exitCode":p.returncode})
    if gateway:gateway.shutdown();gateway.server_close()
    for log in logs:log.close()
    (qa/"private-cleanup.json").write_text(json.dumps({"processes":settled,"allStopped":all(p.poll() is not None for _,p in children)},indent=2)+"\n")
    print(json.dumps({"event":"PRIVATE_STACK_STOPPED","processes":settled}),flush=True)

raise SystemExit(exit_code)
