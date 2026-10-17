#!/usr/bin/env python3
"""Build a Lavish multi-repo evidence-first investigation report from a JSON spec.

Spec schema (see references/investigation-report.md):
{
  "title": "...",
  "out_name": "my-report",         # optional; defaults to slug of title
  "repos": [{"name":"lavish","path":"/abs/path"}, ...],
  "evidence": [
    {"id":"E1","repo":"lavish","path":"SKILL.md","symbol":"code playbook rule",
     "range":{"start":68,"end":68},"explanation":"..."}
  ],
  "summary":     [{"tag":"VERIFIED","text":"...","refs":["E1"]}, ...],
  "problem":     "markdown or plain string",
  "flow":        {"nodes":[{"id":"n1","label":"CLI","evidence":"E1","x":40,"y":40}],
                  "edges":[{"from":"n1","to":"n2","label":"invokes"}]},
  "mapping":     [{"source":"E1","target":"E2","kind":"different","notes":"..."}],
  "proposed":    [{"tag":"INFERRED","text":"...","refs":["E2"]}],
  "assumptions": [...], "unverified":[...], "risks":[...], "questions":[...],
  "likely":      ["path/a.py"], "inspected":["path/b.py"], "out_of_scope":["..."]
}

Nothing here hardcodes a user directory. Machine paths only enter via the spec.
"""
from __future__ import annotations
import argparse, json, hashlib, os, re, secrets, subprocess, sys, html, datetime, pathlib

HERE = pathlib.Path(__file__).resolve().parent
TEMPLATE = (HERE.parent / "templates" / "report.html.tmpl").read_text()

VALID_TAGS = {"VERIFIED", "INFERRED", "UNVERIFIED", "ASSUMPTION"}

def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "report"

def git_info(repo_path: str) -> dict:
    try:
        run = lambda a: subprocess.run(a, cwd=repo_path, capture_output=True, text=True, check=True).stdout.strip()
        h = run(["git","rev-parse","HEAD"])
        b = run(["git","rev-parse","--abbrev-ref","HEAD"])
        dirty = bool(run(["git","status","--porcelain"]))
        return {"hash": h, "short": h[:9], "branch": b, "dirty": dirty}
    except Exception as e:
        return {"hash": "", "short": "-", "branch": "-", "dirty": False, "error": str(e)}

def read_range(path: str, start: int, end: int) -> str:
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    if type(start) is not int or type(end) is not int or not 1 <= start <= end <= len(lines):
        raise ValueError(f"Invalid source range {start}-{end} in {path}")
    return "".join(lines[start-1:end])

def sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()

def validate_refs(items, ev_ids, kind):
    for it in items or []:
        tag = it.get("tag")
        if tag not in VALID_TAGS:
            raise SystemExit(f"{kind}: item missing/invalid tag: {it}")
        refs = it.get("refs") or []
        if tag in ("VERIFIED","INFERRED") and not refs:
            raise SystemExit(f"{kind}: {tag} claim needs at least one ref: {it}")
        for r in refs:
            if r not in ev_ids:
                raise SystemExit(f"{kind}: unknown evidence ref {r} in {it}")

def render_claim_list(items):
    if not items:
        return "<p><em>None.</em></p>"
    lis = []
    for it in items:
        refs = " ".join(f'<a class="eref" href="#ev-{r}">[{r}]</a>' for r in it.get("refs") or [])
        lis.append(f'<li><span class="tag {it["tag"]}">{it["tag"]}</span>{html.escape(it["text"])} {refs}</li>')
    return f'<ul class="claims">{"".join(lis)}</ul>'

def render_repos(repos):
    out = []
    for r in repos:
        gi = r["_git"]
        cls = "git dirty" if gi.get("dirty") else "git"
        out.append(
            f'<div class="repo"><div class="name">{html.escape(r["name"])}</div>'
            f'<div class="path">{html.escape(r["path"])}</div>'
            f'<div class="{cls}">git {html.escape(gi["short"])} · {html.escape(gi["branch"])}{" · DIRTY" if gi.get("dirty") else ""}</div></div>'
        )
    return "".join(out)

def render_flow_svg(flow, evidence_ids):
    if not flow or not flow.get("nodes"):
        return "<p><em>No flow diagram.</em></p>"
    nodes = flow["nodes"]; edges = flow.get("edges", [])
    W = max((n.get("x",0) for n in nodes), default=0) + 200
    H = max((n.get("y",0) for n in nodes), default=0) + 80
    parts = [f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="cross-repo flow">']
    parts.append('<defs><marker id="arr" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#8892a0"/></marker></defs>')
    pos = {n["id"]:(n.get("x",0),n.get("y",0)) for n in nodes}
    for e in edges:
        (x1,y1) = pos.get(e["from"],(0,0)); (x2,y2) = pos.get(e["to"],(0,0))
        parts.append(f'<line x1="{x1+80}" y1="{y1+20}" x2="{x2}" y2="{y2+20}" stroke="#8892a0" stroke-width="1.4" marker-end="url(#arr)"/>')
        if e.get("label"):
            parts.append(f'<text x="{(x1+x2)/2+40}" y="{(y1+y2)/2+10}" fill="#8892a0" font-size="11" font-family="ui-monospace,monospace">{html.escape(e["label"])}</text>')
    for n in nodes:
        x,y = pos[n["id"]]
        ev = n.get("evidence")
        link_open = f'<a href="#ev-{ev}">' if ev and ev in evidence_ids else ""
        link_close = "</a>" if link_open else ""
        parts.append(f'{link_open}<g class="node"><rect x="{x}" y="{y}" width="160" height="40" rx="6" fill="#161a22" stroke="#232936"/><text x="{x+80}" y="{y+25}" text-anchor="middle" fill="#e6edf3" font-size="12">{html.escape(n["label"])}</text></g>{link_close}')
    parts.append("</svg>")
    return "".join(parts)

def render_evidence_cards(evidence):
    out = []
    for ev in evidence:
        dirty = " dirty" if ev["_git"].get("dirty") else ""
        prov = f'working-tree snapshot · HEAD {ev["_git"]["short"]}{" DIRTY" if ev["_git"].get("dirty") else ""}'
        out.append(f'''
<div class="card" id="ev-{ev["id"]}">
  <div class="head">
    <strong>[{ev["id"]}]</strong>
    <span class="path">{html.escape(ev["repo"])} · {html.escape(ev["path"])}:{ev["range"]["start"]}-{ev["range"]["end"]}</span>
    <span class="sym">{html.escape(ev.get("symbol",""))}</span>
    <span class="prov{dirty}" data-prov="{ev["id"]}">{prov}</span>
  </div>
  <div class="expl">{html.escape(ev.get("explanation",""))}</div>
  <div class="banner" data-banner="{ev["id"]}"></div>
  <label>Find in code <input type="search" data-search="{ev["id"]}" aria-label="Search {ev["id"]}"></label>
  <output data-matches="{ev["id"]}"></output>
  <div class="code" data-evidence-code="{ev["id"]}"></div>
  <details><summary>Surrounding context (lines {ev['_context_start']}-{ev['_context_end']})</summary><div class="code" data-context-code="{ev['id']}"></div></details>
  <div class="expl">Related: {' '.join(f'<a href="#ev-{r}">[{r}]</a>' for r in ev.get('related', [])) or 'None'}</div>
  <div class="actions">
    <button data-open="{ev["id"]}">Open in VS Code</button>
    <button data-copy="{ev["id"]}|path">Copy path</button>
    <button data-copy="{ev["id"]}|symbol">Copy symbol</button>
    <button data-copy="{ev["id"]}|snippet">Copy snippet</button>
    <span style="color:#8892a0;font-size:11px;margin-left:auto">sha256 {ev["sha256"][:12]}…</span>
  </div>
</div>''')
    return "".join(out)

def render_mapping(mapping, evidence_by_id):
    if not mapping:
        return "<p><em>No mapping rows.</em></p>"
    rows = ['<table class="mapping"><thead><tr><th>Source</th><th>Target</th><th>Kind</th><th>Notes</th></tr></thead><tbody>']
    for m in mapping:
        s = evidence_by_id.get(m["source"]); t = evidence_by_id.get(m.get("target"))
        def cell(ev, mid_id, is_target):
            if not ev:
                return f'<td class="side"><em>missing evidence</em></td>'
            return (f'<td class="side"><div><a class="eref" href="#ev-{ev["id"]}">[{ev["id"]}]</a> '
                    f'<span style="font-family:ui-monospace,monospace;font-size:11px">{html.escape(ev["repo"])}·{html.escape(ev["path"])}:{ev["range"]["start"]}</span></div>'
                    f'<div>{html.escape(ev.get("symbol", ""))}</div><div data-mapping-code="{ev["id"]}" style="margin-top:6px"></div></td>')
        rows.append("<tr>")
        rows.append(cell(s, m["source"], False))
        rows.append(cell(t, m.get("target"), True))
        rows.append(f'<td><span class="kind {html.escape(m["kind"])}">{html.escape(m["kind"])}</span></td>')
        notes = html.escape(m.get('notes', ''))
        for key,label in [('adaptation','Proposed adaptation'),('direct','Maps directly'),('differences','Architectural differences'),('missing_dependencies','Missing target dependencies')]:
            notes += f'<p><strong>{label}:</strong> {html.escape(m.get(key, "Not assessed"))}</p>'
        rows.append(f'<td>{notes}</td>')
        rows.append("</tr>")
    rows.append("</tbody></table>")
    return "".join(rows)

def render_list(items):
    if not items: return "<p><em>None.</em></p>"
    return "<ul>" + "".join(f"<li><code class=\"inline\">{html.escape(x)}</code></li>" for x in items) + "</ul>"

def render_prose(items):
    if not items: return "<p><em>None.</em></p>"
    return "<ul>" + "".join(f"<li>{html.escape(x)}</li>" for x in items) + "</ul>"

def build(spec_path: str, out_path: str | None):
    spec = json.loads(pathlib.Path(spec_path).read_text())
    title = spec.get("title") or "Investigation report"
    name = spec.get("out_name") or slug(title)

    repos = spec.get("repos") or []
    repo_by_name = {}
    for r in repos:
        r["path"] = str(pathlib.Path(r["path"]).expanduser().resolve(strict=True))
        if r['name'] in repo_by_name:
            raise ValueError('Duplicate repository name')
        r["_git"] = git_info(r["path"])
        repo_by_name[r["name"]] = r

    evidence = spec.get("evidence") or []
    for ev in evidence:
        if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]*', ev['id']):
            raise ValueError('Evidence IDs must be safe HTML identifiers')
        repo = repo_by_name.get(ev["repo"])
        if not repo: raise SystemExit(f"evidence {ev['id']}: unknown repo {ev['repo']}")
        rel = pathlib.Path(ev['path'])
        abs_file = (pathlib.Path(repo['path']) / rel).resolve(strict=True)
        if rel.is_absolute() or not abs_file.is_relative_to(repo['path']) or any(p.startswith('.env') or p in {'.git', '.ssh', 'credentials.json'} for p in rel.parts):
            raise ValueError('Source path escapes repository or targets credentials')
        if abs_file.stat().st_size > 2_000_000:
            raise ValueError('Source too large; choose a smaller source file')
        abs_path = str(abs_file)
        ev["_abs"] = abs_path
        ev["snippet"] = read_range(abs_path, ev["range"]["start"], ev["range"]["end"])
        ev["sha256"] = sha256(ev["snippet"])
        ev["_git"] = repo["_git"]
        count = len(abs_file.read_text(encoding='utf-8').splitlines())
        ev['_context_start'] = max(1, ev['range']['start'] - 15)
        ev['_context_end'] = min(count, ev['range']['end'] + 15)
        ev['context'] = read_range(abs_path, ev['_context_start'], ev['_context_end'])

    ev_ids = {e["id"] for e in evidence}
    if len(ev_ids) != len(evidence):
        raise SystemExit("duplicate evidence ids")
    for ev in evidence:
        if any(r not in ev_ids for r in ev.get('related', [])):
            raise ValueError('Unknown related evidence')
    for m in spec.get('mapping', []):
        if m['source'] not in ev_ids or m.get('target') not in ev_ids | {None} or m['kind'] not in {'direct', 'different', 'dependency'}:
            raise ValueError('Invalid mapping')
    nodes = spec.get('flow', {}).get('nodes', [])
    node_ids = {n['id'] for n in nodes}
    for n in nodes:
        if n.get('evidence') not in ev_ids or any(type(n.get(k, 0)) is not int or n.get(k, 0) < 0 for k in ('x', 'y')):
            raise ValueError('Flow nodes require evidence and nonnegative integer coordinates')
    for e in spec.get('flow', {}).get('edges', []):
        if e['from'] not in node_ids or e['to'] not in node_ids:
            raise ValueError('Unknown flow node')
    for kind in ("summary","proposed","assumptions","risks"):
        validate_refs(spec.get(kind), ev_ids, kind)

    ev_by_id = {e["id"]: e for e in evidence}

    # Build .code-workspace and allowlist
    out_path = pathlib.Path(out_path or f".lavish/{name}.html").resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    workspace = {"folders":[{"name":r["name"],"path":r["path"]} for r in repos], "settings":{}}
    ws_path = out_path.with_suffix(".code-workspace")
    ws_path.write_text(json.dumps(workspace, indent=2))

    token = secrets.token_urlsafe(24)
    port  = 0  # opener chooses; we embed a placeholder and let user pass it in
    # The generator does not bind a port; the opener script prints the URL it binds.
    # For the artifact to reach the opener the user runs `lavish_opener.py <allowlist>`
    # and the opener writes back a `.lavish/<name>.opener.json` that the browser polls.
    allowlist = {
        "token": token,
        "workspace": str(ws_path),
        "entries": {ev["id"]: {"path": ev["_abs"], "line": ev["range"]["start"], "end": ev['range']['end'], "sha256": ev["sha256"]} for ev in evidence},
    }
    allow_path = out_path.with_suffix(".allowlist.json")
    allow_path.write_text(json.dumps(allowlist, indent=2))

    data = {
        "opener": {"url": None, "token": token, "handshake": str(out_path.with_suffix(".opener.json"))},
        "workspace_abs": str(ws_path),
        "evidence": {ev["id"]: {
            "path": ev["path"], "abs_path": ev["_abs"], "symbol": ev.get("symbol",""),
            "range": ev["range"], "snippet": ev["snippet"], "sha256": ev["sha256"],
            "context": ev['context'], "context_start": ev['_context_start'],
        } for ev in evidence},
    }

    subs = {
        "TITLE": html.escape(title),
        "GENERATED_AT": datetime.datetime.now().isoformat(timespec="seconds"),
        "SUMMARY": render_claim_list(spec.get("summary")),
        "PROBLEM": f"<p>{html.escape(spec.get('problem') or '')}</p>",
        "REPOS": render_repos(repos),
        "FLOW_SVG": render_flow_svg(spec.get("flow"), ev_ids),
        "EVIDENCE": render_evidence_cards(evidence),
        "MAPPING": render_mapping(spec.get("mapping"), ev_by_id),
        "PROPOSED": render_claim_list(spec.get("proposed")),
        "ASSUMPTIONS": render_claim_list(spec.get("assumptions")),
        "UNVERIFIED": render_prose(spec.get("unverified")),
        "RISKS": render_claim_list(spec.get("risks")),
        "QUESTIONS": render_prose(spec.get("questions")),
        "LIKELY": render_list(spec.get("likely")),
        "INSPECTED": render_list(spec.get("inspected")),
        "OOS": render_prose(spec.get("out_of_scope")),
        "DATA_JSON": json.dumps(data).replace("</", "<\\/"),
    }
    html_out = re.sub(r'__([A-Z_]+)__', lambda m: subs.get(m[1], m[0]), TEMPLATE)

    out_path.write_text(html_out)
    print(json.dumps({
        "html": str(out_path),
        "workspace": str(ws_path),
        "allowlist": str(allow_path),
        "opener_handshake": str(out_path.with_suffix(".opener.json")),
        "evidence_count": len(evidence),
    }, indent=2))
    return {"html": str(out_path), "workspace": str(ws_path), "allowlist": str(allow_path)}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    build(a.spec, a.out)

if __name__ == "__main__":
    main()
