#!/usr/bin/env python3
"""Safe localhost helper for a Lavish investigation artifact.

Binds 127.0.0.1 on an ephemeral port. Accepts only:
  POST /open       {"id": "<evidence-id>"}   → code --reuse-window --goto <path>:<line>
  POST /workspace  {}                         → code --reuse-window <workspace>
  POST /verify     {}                         → {hashes: {id: sha256_of_live_or_null}}

Guards:
- Loopback only.
- Bearer token in `x-lavish-token` header MUST match token from allowlist JSON.
- Origin (when present) MUST be http://127.0.0.1:<any> or http://localhost:<any>
  or file:// (absent Origin is allowed for file:// artifacts as long as the
  token matches — the token is only in the artifact, which is served from
  the same trust boundary).
- id MUST exist in allowlist. path/line never come from the request.
- No shell interpolation: subprocess with an argv list, no shell=True.
- Writes an `.opener.json` sibling of the allowlist so the browser can
  discover the URL. Removes it on shutdown.

ponytail: single-threaded HTTPServer; fine for one reviewer, upgrade only if
  the artifact drives many parallel clicks.
"""
from __future__ import annotations
import argparse, hashlib, hmac, json, os, pathlib, re, signal, subprocess, sys, threading, urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer


def sha256_range(path, start, end):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        s = "".join(lines[max(0,start-1):min(len(lines),end)])
        return hashlib.sha256(s.encode("utf-8")).hexdigest()
    except OSError:
        return None

def make_handler(state):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a, **k):  # quiet
            pass
        def _json(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("content-type","application/json")
            self.send_header("access-control-allow-origin", self.headers.get("origin","*") or "*")
            self.send_header("access-control-allow-headers","content-type,x-lavish-token")
            self.send_header("access-control-allow-methods","POST,OPTIONS")
            self.send_header("content-length", str(len(data)))
            self.end_headers(); self.wfile.write(data)
        def _check_auth(self):
            # loopback client only (HTTPServer already binds 127.0.0.1, but double-check)
            if self.client_address[0] not in ("127.0.0.1","::1"):
                self._json(403, {"error":"non-loopback"}); return False
            origin = self.headers.get("origin")
            # Lavish intentionally uses an opaque sandbox origin. The per-report
            # token and fixed-ID allowlist remain mandatory for this origin.
            if origin not in (None, 'null'):
                p = urllib.parse.urlparse(origin)
                if p.scheme != 'http' or p.hostname not in ('127.0.0.1', 'localhost') or p.username or p.path not in ('', '/'):
                    self._json(403, {"error":"bad origin"}); return False
            host = self.headers.get('host', '')
            if host not in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'):
                self._json(403, {'error':'bad host'}); return False
            tok = self.headers.get("x-lavish-token","")
            if not hmac.compare_digest(tok, state["token"]):
                self._json(401, {"error":"bad token"}); return False
            return True
        def do_OPTIONS(self):
            self._json(204, {})
        def do_POST(self):
            if not self._check_auth(): return
            try: length = int(self.headers.get('content-length', '0'))
            except ValueError: return self._json(400, {'error':'bad content length'})
            if not 0 <= length <= 4096: return self._json(413, {'error':'request too large'})
            raw = self.rfile.read(length) if length else b"{}"
            try: body = json.loads(raw or b"{}")
            except Exception: return self._json(400, {"error":"bad json"})
            if not isinstance(body, dict): return self._json(400, {'error':'expected object'})

            if self.path == "/open":
                eid = body.get("id")
                if not isinstance(eid, str): return self._json(400, {'error':'expected evidence id'})
                entry = state["entries"].get(eid)
                if not entry: return self._json(404, {"error":"unknown id"})
                argv = [state["code_bin"], "--reuse-window", state['workspace'], "--goto", f'{entry["path"]}:{entry["line"]}']
                try: subprocess.run(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=15)
                except (OSError, subprocess.SubprocessError): return self._json(502, {"error":"VS Code launch failed"})
                return self._json(200, {"ok":True})
            if self.path == "/workspace":
                argv = [state["code_bin"], "--reuse-window", state["workspace"]]
                try: subprocess.run(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=15)
                except (OSError, subprocess.SubprocessError): return self._json(502, {"error":"VS Code launch failed"})
                return self._json(200, {"ok":True})
            if self.path == "/verify":
                out = {eid: sha256_range(e['path'], e['line'], e['end']) for eid, e in state['entries'].items()}
                return self._json(200, {"hashes": out})
            self._json(404, {"error":"not found"})
    return H

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("allowlist", help="path to <name>.allowlist.json produced by build_report.py")
    ap.add_argument("--code-bin", default=os.environ.get("LAVISH_CODE_BIN","code"))
    a = ap.parse_args()
    allow = json.loads(pathlib.Path(a.allowlist).read_text())
    state = {"token": allow["token"], "entries": allow["entries"], "workspace": allow["workspace"], "code_bin": a.code_bin}
    srv = HTTPServer(("127.0.0.1", 0), make_handler(state))
    host, port = srv.server_address
    url = f"http://{host}:{port}"
    handshake = pathlib.Path(a.allowlist).with_suffix("").as_posix()
    # sibling: <name>.opener.json next to <name>.html
    hs_path = pathlib.Path(a.allowlist).with_suffix("").with_suffix(".opener.json") if pathlib.Path(a.allowlist).suffixes[-2:] == [".allowlist",".json"] else pathlib.Path(a.allowlist).with_name(pathlib.Path(a.allowlist).name.replace(".allowlist.json",".opener.json"))
    hs_path.write_text(json.dumps({"url": url}))
    report = pathlib.Path(str(a.allowlist).removesuffix('.allowlist.json') + '.html')
    if report.exists():
        text = report.read_text()
        def connect(match):
            data = json.loads(match.group(1))
            data['opener']['url'] = url
            return '<script id="lavish-report-data" type="application/json">' + json.dumps(data).replace('</', '<\\/') + '</script>'
        text = re.sub(r'<script id="lavish-report-data" type="application/json">(.*?)</script>', connect, text, count=1, flags=re.S)
        report.write_text(text)
    print(json.dumps({"url": url, "handshake": str(hs_path), "entries": list(state["entries"].keys())}, indent=2))
    sys.stdout.flush()
    def cleanup(*_):
        try: hs_path.unlink()
        except FileNotFoundError: pass
        threading.Thread(target=srv.shutdown, daemon=True).start()
    signal.signal(signal.SIGINT, cleanup); signal.signal(signal.SIGTERM, cleanup)
    try: srv.serve_forever()
    finally:
        try: hs_path.unlink()
        except FileNotFoundError: pass

if __name__ == "__main__":
    main()
