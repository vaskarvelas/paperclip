# Reviews

The **Reviews** page (`/reviews`, left sidebar, badge = reviews waiting on the
board) collects agent results that need a human decision: HTML result pages,
samples, plans, reports and questions. Each review belongs to a company, one
responsible agent and optionally a task, and carries a conversation between
the board and that agent.

## Lifecycle

| Status | Meaning | Counted in badge |
|---|---|---|
| `pending_review` | Waiting on the board (new, or the agent replied) | yes |
| `changes_requested` | Board sent feedback; the agent was woken | no |
| `approved` | Board approved; the agent was woken to continue | no |
| `closed` | Closed by the board (no wake) or withdrawn by the agent | no |

Board feedback, approval and closing wake the responsible agent with
`review_feedback`, `review_approved` or `review_closed`, carrying the message
in the wake context. Agent replies (`POST /api/reviews/{id}/messages`) return
the review to `pending_review`.

## Content

A review shows one of: an HTML file on the Paperclip host (`filePath`), inline
HTML (`html`), or an external `url`. HTML is served from
`/api/review-content/{token}/…` with a CSP `sandbox` (opaque origin, no
Paperclip cookies/API) and rendered in a sandboxed iframe. Only the HTML file
and allowlisted asset types in the same directory are reachable; dot-segments,
traversal and symlink escapes are rejected.

## Lavish sessions

With `lavish: true`, Paperclip opens a [lavish-axi](https://www.npmjs.com/package/lavish-axi)
session for the file (`lavish-axi <file> --no-open`) and links it from the
review. A server job polls every open Lavish review with a zero-timeout
`GET /api/poll` on the local Lavish server, so neither Paperclip nor the agent
holds a long poll open:

1. queued agent replies are delivered to the Lavish conversation;
2. new annotations/prompts become a board message, move the review to
   `changes_requested`, and wake the agent;
3. a Lavish session ended by the user stops polling for that review.

If the Lavish server has idled out, the job reopens the session (which
restarts the server) once per tick. Approving or closing a review ends its
Lavish session. The board can trigger a poll immediately with **Check Lavish
now** (`POST /api/companies/{companyId}/reviews/poll`).

| Environment variable | Default | Purpose |
|---|---|---|
| `PAPERCLIP_REVIEW_POLL_INTERVAL_MS` | `60000` (min `5000`, `0` disables) | Lavish poll cadence |
| `PAPERCLIP_LAVISH_URL` | `http://127.0.0.1:$LAVISH_AXI_PORT` (`4387`) | Lavish server base URL |
| `PAPERCLIP_LAVISH_BIN` | `lavish-axi` on `PATH`, `~/.local/bin`, `~/.npm-global/bin` | CLI used to open sessions |

Agent-facing instructions live in `skills/paperclip/references/reviews.md`
and the `paperclip-submit-review.sh` helper.
