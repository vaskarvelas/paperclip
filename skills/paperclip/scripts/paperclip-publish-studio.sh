#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  paperclip-publish-studio.sh [FILE.html] --slug <slug> --title "<title>" [options]

Publish or update a persistent Studio page (voices, sound effects, art styles,
mascot identities, episode gates, design decisions) in the company's Studio hub
and shared Studio disk directory (~/.paperclip/instances/default/studio/<slug>/).

Options:
  --slug <slug>           Required stable identifier (e.g. voices-sound, art-styles-mascots)
  --title <title>         Required display title
  --category <cat>        voices_sound | art_mascots | episodes | decisions | other (default: other)
  --summary <markdown>    Short context shown above the choice bar
  --issue-id <uuid>       Associated issue UUID (defaults to $PAPERCLIP_TASK_ID)
  --review-id <uuid>      Associated review UUID
  --agent-id <uuid>       Responsible agent UUID (defaults to caller agent)
  --external-url <url>    Optional live workbench URL (e.g. http://127.0.0.1:7865)
  --choices-json <json>   JSON array of {id, label, group?, description?} options
  --status <status>       awaiting_choice | choice_made | reference
  --pinned-order <int>    Sort priority (lower appears first, default 0)
  --lavish                Also open/ensure an interactive Lavish session
  --json                  Print raw JSON response
EOF
}

file=""
slug=""
title=""
category="other"
summary=""
issue_id="${PAPERCLIP_TASK_ID:-}"
review_id=""
agent_id=""
external_url=""
choices_json="[]"
status=""
pinned_order="0"
lavish=false
output="markdown"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --slug) slug="${2:-}"; shift 2 ;;
    --title) title="${2:-}"; shift 2 ;;
    --category) category="${2:-}"; shift 2 ;;
    --summary) summary="${2:-}"; shift 2 ;;
    --issue-id) issue_id="${2:-}"; shift 2 ;;
    --review-id) review_id="${2:-}"; shift 2 ;;
    --agent-id) agent_id="${2:-}"; shift 2 ;;
    --external-url) external_url="${2:-}"; shift 2 ;;
    --choices-json) choices_json="${2:-[]}"; shift 2 ;;
    --status) status="${2:-}"; shift 2 ;;
    --pinned-order) pinned_order="${2:-0}"; shift 2 ;;
    --lavish) lavish=true; shift ;;
    --json) output="json"; shift ;;
    -*) echo "Unknown flag: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -z "$file" ]]; then file="$1"; shift
      else echo "Unexpected argument: $1" >&2; usage >&2; exit 2
      fi
      ;;
  esac
done

if [[ -z "$slug" ]]; then echo "--slug is required" >&2; exit 2; fi
if [[ -z "$title" ]]; then echo "--title is required" >&2; exit 2; fi
for name in PAPERCLIP_API_URL PAPERCLIP_COMPANY_ID; do
  if [[ -z "${!name:-}" ]]; then echo "$name is not set" >&2; exit 2; fi
done
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 2; }

file_path=""
if [[ -n "$file" ]]; then
  file_path="$(realpath "$file")"
fi

payload="$(jq -n \
  --arg slug "$slug" \
  --arg title "$title" \
  --arg category "$category" \
  --arg summary "$summary" \
  --arg issueId "$issue_id" \
  --arg reviewId "$review_id" \
  --arg agentId "$agent_id" \
  --arg filePath "$file_path" \
  --arg externalUrl "$external_url" \
  --arg status "$status" \
  --argjson choices "$choices_json" \
  --argjson pinnedOrder "$pinned_order" \
  --argjson lavish "$lavish" \
  '{slug: $slug, title: $title, category: $category, copyToStudioDir: true, pinnedOrder: $pinnedOrder, lavish: $lavish}
   + (if $summary != "" then {summary: $summary} else {} end)
   + (if $issueId != "" then {issueId: $issueId} else {} end)
   + (if $reviewId != "" then {reviewId: $reviewId} else {} end)
   + (if $agentId != "" then {agentId: $agentId} else {} end)
   + (if $filePath != "" then {filePath: $filePath} else {} end)
   + (if $externalUrl != "" then {externalUrl: $externalUrl} else {} end)
   + (if $status != "" then {selectionStatus: $status} else {} end)
   + (if ($choices | length) > 0 then {choices: $choices} else {} end)')"

api_base="${PAPERCLIP_API_URL%/}"
api_base="${api_base%/api}"
response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT

auth_args=()
if [[ -n "${PAPERCLIP_API_KEY:-}" ]]; then
  auth_args+=(-H "Authorization: Bearer $PAPERCLIP_API_KEY")
fi
if [[ -n "${PAPERCLIP_RUN_ID:-}" ]]; then
  auth_args+=(-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID")
fi

status_code="$(curl -sS -o "$response_file" -w '%{http_code}' -X POST \
  "$api_base/api/companies/$PAPERCLIP_COMPANY_ID/studio" \
  "${auth_args[@]}" \
  -H "Content-Type: application/json" \
  --data "$payload")"

if [[ "$status_code" != "201" ]]; then
  echo "Failed to publish Studio page (HTTP $status_code):" >&2
  cat "$response_file" >&2
  exit 1
fi

if [[ "$output" == "json" ]]; then
  cat "$response_file"
  exit 0
fi

jq -r '
  "Published Studio page **\(.title)** (`\(.slug)` → `\(.filePath // .externalUrl)`): category `\(.category)`, status `\(.selectionStatus)`."
' "$response_file"
