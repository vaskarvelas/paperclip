# Multi-repo evidence-first investigation report

Reference for building a Lavish artifact that presents a code investigation
spanning one or more repositories where **every claim links to inspected
source** and the reviewer can open the exact line in VS Code.

This extends the base skill; it does not replace it. The code surface still
follows the `code` playbook (`@pierre/diffs`), the design fallback rules and
the poll workflow still apply.

## When to use

- The response would otherwise be a long "here's what I found across repos X,
  Y, Z" prose dump.
- Findings must be traceable to file + line + git ref, not paraphrased.
- The reviewer needs to jump into the code to verify, not just read.

## Required sections (in order)

1. **Summary** — 3-6 bullets, each ending with `[E#]` evidence refs.
2. **Problem** — what triggered the investigation.
3. **Repositories** — for each repo: name, absolute path, current git ref +
   short hash, branch, dirty flag.
4. **Flow** — inline SVG (not Mermaid) showing the cross-repo path; nodes
   clickable to their evidence card. Keep to one screen.
5. **Evidence** — the evidence cards (schema below). This is the spine.
6. **Source → target mapping** — side-by-side table: for each source symbol,
   the target symbol, the adaptation kind (`direct` / `different` /
   `dependency`), and a short note. Each row cites `[E#]` on both sides.
7. **Proposed changes** — grouped by file, each item cites `[E#]`.
8. **Assumptions** — explicit, each labelled `ASSUMPTION` with the evidence
   it rests on (or "no direct evidence" if none).
9. **Unverified** — things you looked for but could not confirm.
10. **Risks**
11. **Open questions** for the reviewer.
12. **Files likely to change** — path list, no edits yet.
13. **Inspected, not changed** — files read for context only.
14. **Out of scope**

Ship the report **before** touching application code. This artifact is the
review gate, not a post-hoc summary.

## Evidence card schema

Every card has:

- `id` — stable slug (`E1`, `E2`, ... or `E-auth-guard`). Referenced everywhere.
- `repo` — one of the repos declared in section 3.
- `path` — repo-relative.
- `symbol` — function / class / const name being inspected.
- `range` — `{start, end}` 1-indexed line numbers.
- `explanation` — 1-3 sentences: what this proves.
- `snippet` — the actual lines, captured at build time.
- `sha256` — hash of the snippet at build time (provenance).
- `git` — `{ref, hash, dirty}` captured at build time.

Rendered card MUST show:

- Header: `repo · path:startLine-endLine · symbol`
- Provenance badge: `git <shortHash>` + `dirty` warning if the working tree
  was dirty at capture.
- **Mismatch banner** if the live file's snippet hash differs from the
  captured `sha256` when the opener helper is running (checked on demand).
- Code, rendered with `@pierre/diffs` `File` (real `<code>` lines →
  browser Ctrl+F search, native selection, native scroll).
- Buttons: copy absolute path/symbol/snippet and open in VS Code at the range's start line. Expand/collapse captured context (15 surrounding lines on each side); per-card search returns exact source line numbers. The viewer omits excerpt-relative gutters to avoid confusing them with source line numbers; exact ranges remain in the header.
- `Related` — links to other evidence IDs that share the file or symbol.

## Claim classification (enforced)

Every load-bearing statement in Summary, Problem, Proposed changes,
Assumptions, Risks MUST carry one of these tags and at least one
`[E#]` reference (except `ASSUMPTION` and `UNVERIFIED`, which may say
"no direct evidence"):

- `VERIFIED` — supported by a snippet actually read from the repo.
- `INFERRED` — reasoned from VERIFIED evidence; the leap is explicit.
- `UNVERIFIED` — expected but not yet confirmed; still worth stating.
- `ASSUMPTION` — taken as given without evidence; must be flagged.

The generator refuses to emit a report where a Summary/Proposed/Assumption
bullet has no tag or dangles an `[E#]` that is not defined.

## Source → target mapping rows

| column | meaning |
|--------|---------|
| Source | evidence card in the source repo |
| Target | evidence card (or file path) in the target repo |
| Kind | `direct` (copy/port), `different` (semantically same, code differs), `dependency` (target consumes source as a library) |
| Notes | risks / gotchas / API delta |

Render side-by-side (two `File` views, one per column) when both sides have
code; fall back to a single-column list of `[E#] → [E#]` rows for lightweight
mappings.

## Opener helper contract

- Loopback only (`127.0.0.1`).
- The builder creates a per-report token; the helper selects a random port and embeds its URL into the report data on startup. Build, start helper, then open Lavish; restart the helper after rebuilding. Do not use a sibling-JSON XHR handshake: Lavish's opaque sandbox cannot fetch it without CORS.
- Accepts only `POST /open` with JSON `{id}` and `POST /workspace`.
- `id` MUST appear in the allowlist JSON produced by the build.
- Origin must be loopback HTTP, opaque `null` (Lavish sandbox/file report), or absent (local CLI). All require the capability token. Host must match the helper's loopback address/port. This does not protect against malicious local software or a compromised report/CDN script.
- No arbitrary paths, no shell strings, no query params reach `code(1)`.
  The allowlist maps id → resolved absolute `path` and `line`; the helper
  invokes `code --reuse-window --goto <path>:<line>`.
- Never bind to `0.0.0.0`. Never publish. Never accept a non-loopback
  `Origin`. Never log the token.

If the helper is unavailable, buttons show a clear instruction rather than using a URI that might create another window. Every file-open command includes the workspace and `--reuse-window --goto`; this is workspace reuse, not a window-ID API. Do not promise stronger multi-window behavior without testing it.

Source/context and CSS are embedded. Syntax highlighting uses pinned `@pierre/diffs` from esm.sh; offline a read-only textarea preserves source/search/copy but lacks highlighting. Reports must remain local. For sensitive work vendor reviewed viewer assets rather than running third-party CDN code with source access; never publish source or capability-bearing reports without explicit authorization and security review.

The generator reads the working tree, not arbitrary Git refs. HEAD/branch are contextual provenance, not proof of byte equivalence to a commit. For fresh-ref investigations use an isolated checked-out worktree at the inspected commit. Never label stale local code origin/develop. Invalid ranges, unsafe IDs, path/symlink escapes, credential-like paths and files over 2 MB are rejected; this is not a general secret scanner. Inspect source plus surrounding context before capture.

Use `related` IDs on cards. Mapping rows accept `adaptation`, `direct`, `differences`, and `missing_dependencies`; omitted fields visibly say Not assessed. A missing target can be null; never invent target code. Include repo names in likely/inspected path lists.

The builder validates references in summary/proposed/assumptions/risks, not claim truth. Problem is request prose; unverified/questions/out_of_scope are plain lists. Put technical assertions in tagged sections. Keep unrelated findings out of implementation scope.

Run the helper as a tracked server, verify readiness with `/verify`, and stop it when review ends. Preserve the existing Lavish poll/review lifecycle.

## Build / verify commands

```
python3 ~/.agents/skills/lavish/scripts/build_report.py <spec.json> --out .lavish/<name>.html
python3 ~/.agents/skills/lavish/scripts/lavish_opener.py .lavish/<name>.allowlist.json
python3 ~/.agents/skills/lavish/scripts/test_build_report.py
npx -y lavish-axi .lavish/<name>.html
```

The spec file is user-supplied and holds the only machine-specific paths;
nothing in this skill hardcodes a user directory.
