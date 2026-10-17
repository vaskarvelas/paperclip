#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  paperclip-submit-review.sh [FILE.html] --title TEXT [options]

Submits a result to the board's Reviews page (left sidebar, with a count badge).
The board reviews it there and replies; you are woken with
PAPERCLIP_WAKE_REASON=review_feedback | review_approved | review_closed.

Required environment:
  PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID

Options:
  --title TEXT       Review title (required): name the decision you need
  --summary TEXT     Markdown shown above the result
  --kind KIND        result (default) | sample | question | plan | report
  --issue-id ID      Task id (default: PAPERCLIP_TASK_ID when set)
  --lavish           Open an interactive Lavish session for FILE (Paperclip
                     polls it every minute; do not run `lavish-axi poll`)
  --url URL          Link to an external page instead of FILE
  --output FORMAT    markdown (default) or json
  --help, -h         Show this help

Examples:
  bash scripts/paperclip-submit-review.sh .lavish/options.html \
    --title "Pick a hero layout" --kind sample --lavish

  bash scripts/paperclip-submit-review.sh --kind question \
    --title "Which pricing tier ships first?" --summary "A: Pro only. B: Pro + Team."
EOF
}

file=""
title=""
summary=""
kind="result"
issue_id="${PAPERCLIP_TASK_ID:-}"
lavish=false
url=""
output="markdown"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title) title="$2"; shift 2 ;;
    --summary) summary="$2"; shift 2 ;;
    --kind) kind="$2"; shift 2 ;;
    --issue-id) issue_id="$2"; shift 2 ;;
    --lavish) lavish=true; shift ;;
    --url) url="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -n "$file" ]]; then echo "Only one FILE may be given" >&2; exit 2; fi
      file="$1"; shift ;;
  esac
done

if [[ -z "$title" ]]; then echo "--title is required" >&2; exit 2; fi
for name in PAPERCLIP_API_URL PAPERCLIP_API_KEY PAPERCLIP_COMPANY_ID; do
  if [[ -z "${!name:-}" ]]; then echo "$name is not set" >&2; exit 2; fi
done
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 2; }

file_path=""
if [[ -n "$file" ]]; then
  if [[ ! -f "$file" ]]; then echo "File not found: $file" >&2; exit 2; fi
  file_path="$(cd "$(dirname "$file")" && pwd -P)/$(basename "$file")"
fi
if [[ "$lavish" == true && -z "$file_path" ]]; then echo "--lavish requires FILE" >&2; exit 2; fi

payload="$(jq -n \
  --arg title "$title" \
  --arg summary "$summary" \
  --arg kind "$kind" \
  --arg issueId "$issue_id" \
  --arg filePath "$file_path" \
  --arg url "$url" \
  --argjson lavish "$lavish" \
  '{title: $title, kind: $kind, lavish: $lavish}
   + (if $summary != "" then {summary: $summary} else {} end)
   + (if $issueId != "" then {issueId: $issueId} else {} end)
   + (if $filePath != "" then {filePath: $filePath} else {} end)
   + (if $url != "" then {url: $url} else {} end)')"

api_base="${PAPERCLIP_API_URL%/}"
api_base="${api_base%/api}"
response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT
status_code="$(curl -sS -o "$response_file" -w '%{http_code}' -X POST \
  "$api_base/api/companies/$PAPERCLIP_COMPANY_ID/reviews" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  ${PAPERCLIP_RUN_ID:+-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"} \
  -H "Content-Type: application/json" \
  --data "$payload")"

if [[ "$status_code" != "201" ]]; then
  echo "Review submission failed (HTTP $status_code):" >&2
  cat "$response_file" >&2
  echo >&2
  exit 1
fi

if [[ "$output" == "json" ]]; then
  cat "$response_file"
  exit 0
fi

jq -r '
  "Submitted review **\(.title)** (`\(.id)`): status \(.status)." +
  (if .lavishEnabled then
     (if .lavishSessionUrl then " Lavish session: \(.lavishSessionUrl)." else " Lavish session could not open: \(.lavishLastError // "unknown error")." end)
   else "" end)
' "$response_file"
