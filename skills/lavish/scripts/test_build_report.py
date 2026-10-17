#!/usr/bin/env python3
"""Runnable checks for build_report.py + lavish_opener.py.

Real end-to-end: builds an artifact from actual public sources
(the installed lavish-axi CLI + the lavish SKILL.md) and drives the opener
with a stubbed `code` binary that just records argv.
"""
from __future__ import annotations
import json, os, pathlib, subprocess, sys, tempfile, time, urllib.request, urllib.error, hashlib, shutil, http.client

HERE = pathlib.Path(__file__).resolve().parent
SKILL_ROOT = HERE.parent
BUILD = HERE / "build_report.py"
OPEN  = HERE / "lavish_opener.py"

def find_lavish_cli():
    for cand in [
        pathlib.Path.home()/".npm-global/lib/node_modules/lavish-axi/dist/cli.mjs",
        pathlib.Path("/usr/lib/node_modules/lavish-axi/dist/cli.mjs"),
    ]:
        if cand.exists(): return cand
    raise SystemExit("lavish-axi not installed globally; test requires it")

def http_post(url, path, body, headers):
    u = url + path
    req = urllib.request.Request(u, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type":"application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")

def main():
    cli = find_lavish_cli()
    # discover a small stable range in the public cli.mjs (first shebang/header block)
    cli_text = cli.read_text(errors="replace").splitlines()
    header_end = min(30, len(cli_text))

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="lavish-invest-"))
    spec = {
        "title": "Lavish investigation demo (self-test)",
        "out_name": "demo",
        "repos": [
            {"name": "lavish-skill", "path": str(SKILL_ROOT)},
            {"name": "lavish-axi",   "path": str(cli.parent.parent)},  # package root
        ],
        "evidence": [
            {"id":"E1","repo":"lavish-skill","path":"SKILL.md","symbol":"code playbook rule",
             "range":{"start":85,"end":101},
             "explanation":"The investigation section names the code viewer and helper workflow."},
            {"id":"E2","repo":"lavish-axi","path":"dist/cli.mjs","symbol":"cli header",
             "range":{"start":1,"end":header_end},
             "explanation":"Top of the public lavish-axi CLI bundle used as demo source."},
        ],
        "problem": "Show how to extend Lavish with an evidence-first report using only public sources.",
        "summary": [
            {"tag":"VERIFIED","text":"Skill requires @pierre/diffs for code surfaces.","refs":["E1"]},
            {"tag":"INFERRED","text":"Any new code viewer must reuse @pierre/diffs, not add CodeMirror.","refs":["E1"]},
        ],
        "flow": {"nodes":[
            {"id":"a","label":"Skill","x":40,"y":40,"evidence":"E1"},
            {"id":"b","label":"lavish-axi CLI","x":320,"y":40,"evidence":"E2"},
        ],"edges":[{"from":"a","to":"b","label":"invokes"}]},
        "mapping": [{"source":"E1","target":"E2","kind":"different",
                     "notes":"Different source types for exercising comparison UI; no enforcement relationship is claimed."}],
        "proposed": [{"tag":"INFERRED","text":"Use the documented extension workflow.","refs":["E1"]}],
        "assumptions": [{"tag":"ASSUMPTION","text":"Reviewer has `code` on PATH.","refs":[]}],
        "unverified": ["Behaviour under non-UTF8 source files"],
        "risks": [{"tag":"INFERRED","text":"Stale evidence if the file changes after build.","refs":["E2"]}],
        "questions": ["OK to require Python 3.9+?"],
        "likely": ["scripts/build_report.py","templates/report.html.tmpl"],
        "inspected": ["SKILL.md","dist/cli.mjs"],
        "out_of_scope": ["public sharing"],
    }
    spec_path = tmp/"spec.json"; spec_path.write_text(json.dumps(spec))
    out_html = tmp/"demo.html"
    r = subprocess.run([sys.executable, str(BUILD), str(spec_path), "--out", str(out_html)],
                       capture_output=True, text=True)
    assert r.returncode == 0, f"build failed: {r.stderr}\n{r.stdout}"
    meta = json.loads(r.stdout)
    html = out_html.read_text()
    for needle in ["ev-E1","ev-E2","@pierre/diffs","git ","--reuse-window\" nope"[:0] or "Open in VS Code","data-evidence-code=\"E1\""]:
        assert needle in html, f"missing {needle!r} in generated html"
    # allowlist and workspace
    aw = json.loads(pathlib.Path(meta["allowlist"]).read_text())
    assert set(aw["entries"].keys()) == {"E1","E2"}
    ws = json.loads(pathlib.Path(meta["workspace"]).read_text())
    assert len(ws["folders"]) == 2

    # Generator must supply the same range used to capture evidence.
    for ev in spec["evidence"]:
        assert aw['entries'][ev['id']]['end'] == ev['range']['end']
    import copy
    for field, value in [('id', '\"><script>'), ('path', '../outside'), ('range', {'start':0,'end':2})]:
        bad=copy.deepcopy(spec);bad['evidence'][0][field]=value
        badpath=tmp/'bad.json';badpath.write_text(json.dumps(bad))
        result=subprocess.run([sys.executable,str(BUILD),str(badpath),'--out',str(tmp/'bad.html')],capture_output=True)
        assert result.returncode != 0 and not (tmp/'bad.html').exists()
    bad=copy.deepcopy(spec);bad['summary'][0]['refs']=[]
    badpath.write_text(json.dumps(bad))
    assert subprocess.run([sys.executable,str(BUILD),str(badpath)],capture_output=True).returncode != 0

    # stubbed `code` that records argv
    stub_dir = tmp/"bin"; stub_dir.mkdir()
    code_log = tmp/"code.log"
    stub = stub_dir/"code"
    stub.write_text(f"#!/usr/bin/env bash\necho \"$@\" >> {code_log}\n")
    stub.chmod(0o755)

    proc = subprocess.Popen(
        [sys.executable, str(OPEN), str(meta["allowlist"]), "--code-bin", str(stub)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    # read the first JSON blob (multi-line)
    buf = ""
    while True:
        line = proc.stdout.readline()
        if not line:
            err = proc.stderr.read(); raise SystemExit(f"opener died: {err}")
        buf += line
        try: info = json.loads(buf); break
        except json.JSONDecodeError: continue
    url, token = info["url"], aw["token"]
    try:
        # good open
        s, b = http_post(url, "/open", {"id":"E1"}, {"x-lavish-token": token})
        assert s == 200 and b.get("ok"), (s,b)
        # bad token
        s, b = http_post(url, "/open", {"id":"E1"}, {"x-lavish-token": "nope"})
        assert s == 401, (s,b)
        # bad id
        s, b = http_post(url, "/open", {"id":"E-nope"}, {"x-lavish-token": token})
        assert s == 404, (s,b)
        # bad origin
        s, b = http_post(url, "/open", {"id":"E1"}, {"x-lavish-token": token, "origin": "http://evil.example.com"})
        assert s == 403, (s,b)
        s,b=http_post(url,'/open',[],{'x-lavish-token':token})
        assert s==400
        s,b=http_post(url,'/open',{'id':[]},{'x-lavish-token':token})
        assert s==400
        # workspace
        s, b = http_post(url, "/workspace", {}, {"x-lavish-token": token})
        assert s == 200, (s,b)
        # verify: E1/E2 hashes present and match captured (no drift yet)
        s, b = http_post(url, "/verify", {}, {"x-lavish-token": token})
        assert s == 200 and "hashes" in b
        assert all(b['hashes'][eid]==entry['sha256'] for eid,entry in aw['entries'].items())
        # simulate drift by touching a temp copy — write a modified E2 source into a shadow file
        # and remap the entry to it, then re-verify:
        shadow = tmp/"shadow-cli.mjs"; shadow.write_text("// drifted\n" + pathlib.Path(aw["entries"]["E2"]["path"]).read_text(errors="replace"))
        aw2 = json.loads(pathlib.Path(meta["allowlist"]).read_text())
        aw2["entries"]["E2"]["path"] = str(shadow)
        pathlib.Path(meta["allowlist"]).write_text(json.dumps(aw2))
        # opener already loaded state at boot — restart to pick up the change
        proc.terminate(); proc.wait(timeout=3)

        proc2 = subprocess.Popen([sys.executable, str(OPEN), str(meta["allowlist"]), "--code-bin", str(stub)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        buf2 = ""
        while True:
            line = proc2.stdout.readline()
            if not line: raise SystemExit("opener2 died")
            buf2 += line
            try: info2 = json.loads(buf2); break
            except json.JSONDecodeError: continue
        s, b = http_post(info2["url"], "/verify", {}, {"x-lavish-token": token})
        assert s == 200
        assert b["hashes"]["E2"] != aw["entries"]["E2"]["sha256"], "expected drift"
        proc2.terminate(); proc2.wait(timeout=3)

        # code binary was invoked
        assert code_log.exists() and code_log.read_text().strip(), "code stub was not called"
        log = code_log.read_text()
        assert "--reuse-window" in log and "--goto" in log
    finally:
        try: proc.terminate()
        except Exception: pass

    print("OK  artifacts:", meta)
    print("OK  html size:", len(html), "bytes")
    print("OK  code invocations:")
    print(code_log.read_text())

if __name__ == "__main__":
    main()
