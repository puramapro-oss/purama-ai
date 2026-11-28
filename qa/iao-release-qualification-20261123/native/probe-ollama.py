"""Bounded provider probe on the user's existing Ollama, not an IAO E2E test.

No package installation, cloud API, tool execution, service mutation or model pull.
Synthetic fixtures only; private model reasoning is deliberately not recorded.
Each case has an explicit oracle; failures retain a nonzero process exit status.
"""
import argparse
import datetime
import hashlib
import json
import signal
import time
import urllib.error
import urllib.request

ORIGIN = "http://127.0.0.1:11434"
MODEL = "qwen3.5:4b"
MAX_BYTES = 1024 * 1024
TIMEOUT = 50


def request(path, payload):
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    req = urllib.request.Request(ORIGIN + path, data=raw, headers={"Content-Type": "application/json"})
    # This loopback-only fixture must not inherit proxies or follow redirects.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(req, timeout=TIMEOUT) as response:
        body = response.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            raise ValueError("response_too_large")
        return response.status, json.loads(body), hashlib.sha256(raw).hexdigest()


def native(prompt, think, extra=None):
    payload = {"model": MODEL, "messages": [{"role": "user", "content": prompt}],
               "think": think, "stream": False, "options": {"temperature": 0, "num_predict": 1024}}
    payload.update(extra or {})
    return payload


CALCULATE = "Calcule 6 × 7. Réponds uniquement par le nombre entier."
TOOL = {"type": "function", "function": {"name": "prepare_fixture",
    "description": "Prépare une donnée synthétique sans effet réel.",
    "parameters": {"type": "object", "properties": {"title": {"type": "string"}},
                   "required": ["title"], "additionalProperties": False}}}
EXTRACT = {"title": "Création 東京 🌱", "quantity": 7, "currency": "EUR"}
EXTRACT_SCHEMA = {"type": "object", "properties": {
    "title": {"type": "string"}, "quantity": {"type": "integer"}, "currency": {"type": "string"}},
    "required": ["title", "quantity", "currency"], "additionalProperties": False}
PLAN_SCHEMA = {"type": "object", "properties": {"order": {"type": "array", "items": {"type": "string"}},
    "total_minutes": {"type": "integer"}}, "required": ["order", "total_minutes"], "additionalProperties": False}
CASES = [
    ("openai_compat_42_1024", "/v1/chat/completions", {"model": MODEL,
        "messages": [{"role": "user", "content": CALCULATE}], "temperature": 0,
        "max_tokens": 1024, "stream": False}, "text", "42"),
    ("native_thinking_enabled_42", "/api/chat", native(CALCULATE, True), "text", "42"),
    ("native_thinking_disabled_42", "/api/chat", native(CALCULATE, False), "text", "42"),
    ("native_multilingual_schema", "/api/chat", native(
        "Extrais exactement en JSON, sans ajouter de champ : titre = Création 東京 🌱 ; quantité = 7 ; monnaie = EUR. "
        "Les clés sont title, quantity et currency.", False, {"format": EXTRACT_SCHEMA}), "json", EXTRACT),
    ("native_structured_tool_no_execution", "/api/chat", native(
        "Appelle prepare_fixture une seule fois avec title exactement égal à Création à Frasne. Ne traduis pas le titre.",
        False, {"tools": [TOOL]}), "tool", {"title": "Création à Frasne"}),
    ("native_context_recall", "/api/chat", native("", False, {"messages": [
        {"role": "user", "content": "Pour cette tâche synthétique uniquement : le projet porte la référence AZUR-7391."},
        {"role": "assistant", "content": "La référence est enregistrée dans le contexte de cette conversation."},
        {"role": "user", "content": "Quelle est la référence ? Réponds uniquement par cette référence."}]}), "text", "AZUR-7391"),
    ("native_dependency_plan", "/api/chat", native(
        "Planifie ces opérations synthétiques, exécutées par une seule personne sans parallélisme : "
        "A dure 12 minutes ; B dure 7 minutes et attend A ; C dure 5 minutes et attend B ; D dure 9 minutes et attend C. "
        "Réponds en JSON avec order (identifiants dans l'ordre d'exécution) et total_minutes (somme exacte).",
        False, {"format": PLAN_SCHEMA}), "json", {"order": ["A", "B", "C", "D"], "total_minutes": 33}),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch", choices=["reasoning", "structured", "all"], default="all")
    args = parser.parse_args()
    selected = CASES if args.batch == "all" else CASES[:3] if args.batch == "reasoning" else CASES[3:]
    failures = 0
    def deadline_reached(_signal, _frame):
        raise TimeoutError("wall_deadline")
    signal.signal(signal.SIGALRM, deadline_reached)
    for name, path, payload, kind, expected in selected:
        started = time.monotonic()
        receipt = {"case": name, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   "scope": "real_local_provider_component_only", "provider": "Ollama", "model": MODEL,
                   "path": path, "request": payload, "oracle_kind": kind, "expected": expected,
                   "tool_execution": False, "max_response_bytes": MAX_BYTES, "wall_deadline_seconds": TIMEOUT,
                   "provider_metrics_are_declarative": True}
        try:
            signal.setitimer(signal.ITIMER_REAL, TIMEOUT)
            status, data, request_hash = request(path, payload)
            message = data["choices"][0]["message"] if path.startswith("/v1/") else data["message"]
            answer = message.get("content", "").strip()
            finish = data["choices"][0].get("finish_reason") if path.startswith("/v1/") else data.get("done_reason")
            calls = message.get("tool_calls", [])
            thinking_present = bool(message.get("thinking") or message.get("reasoning"))
            receipt.update({"http_status": status, "request_sha256": request_hash,
                "response_model": data.get("model"), "answer": answer, "tool_calls": calls,
                "finish_reason": finish, "thinking_present": thinking_present,
                "usage": data.get("usage"), "prompt_eval_count": data.get("prompt_eval_count"),
                "eval_count": data.get("eval_count"), "total_duration_ns": data.get("total_duration"),
                "load_duration_ns": data.get("load_duration")})
            actual = json.loads(answer) if kind == "json" else answer
            if kind == "tool":
                actual = calls[0]["function"]["arguments"] if len(calls) == 1 and calls[0]["function"]["name"] == "prepare_fixture" else None
                if isinstance(actual, str):
                    actual = json.loads(actual)
            complete = finish in ("stop", "tool_calls") and (path.startswith("/v1/") or data.get("done") is True)
            passed = status == 200 and complete and actual == expected and (kind == "tool" or not calls)
            # This observes the response field, not the model's internal computation.
            thinking_field_matches = "think" not in payload or thinking_present == payload["think"]
            receipt.update({"complete": complete, "thinking_field_matches": thinking_field_matches, "actual": actual,
                "pass": passed and data.get("model") == MODEL and thinking_field_matches})
        except Exception as exc:
            receipt.update({"pass": False, "error_type": type(exc).__name__})
            if isinstance(exc, urllib.error.HTTPError):
                receipt["http_status"] = exc.code
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
        receipt["elapsed_ms"] = round((time.monotonic() - started) * 1000, 1)
        failures += int(not receipt["pass"])
        print(json.dumps(receipt, ensure_ascii=False), flush=True)
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
