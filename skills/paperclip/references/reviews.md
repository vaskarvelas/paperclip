# Board Reviews

Reviews are the board user's queue of agent results that need a human look:
HTML result pages, samples, plans, reports and questions. They appear on the
**Reviews** page in the left sidebar with a count badge, and each review has a
conversation between the user and the responsible agent.

Submit a review whenever you need the user to **look at, choose between, or
approve** something before the work can progress. Prefer one review per
decision; group closely related samples into one HTML page.

## Submit a review

Headers on every call: `Authorization: Bearer $PAPERCLIP_API_KEY`,
`X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID`, `Content-Type: application/json`.

`POST /api/companies/{companyId}/reviews`

| Field | Notes |
|---|---|
| `title` | Required, ≤300 chars. Name the decision ("Pick a hero layout"). |
| `summary` | Markdown shown above the result: what to look at, what you need. |
| `kind` | `result` (default), `sample`, `question`, `plan`, `report`. |
| `issueId` | The task this belongs to (usually `$PAPERCLIP_TASK_ID`). |
| `filePath` | Absolute path to an `.html`/`.htm` file on the Paperclip host. |
| `html` | Inline HTML (≤2 MiB) when you cannot share a file path. |
| `url` | External `http(s)` link instead of HTML. |
| `lavish` | `true` opens an interactive Lavish session for `filePath`. |

Use at most one of `filePath`, `html`, `url`. A `question` may have none and
carry everything in `summary`. Agents are recorded as the responsible agent
automatically.

The helper does the call for you:

```bash
bash "$paperclip_skill_dir/scripts/paperclip-submit-review.sh" .lavish/hero-options.html \
  --title "Pick a hero layout" --kind sample --lavish \
  --summary "Three layouts. Annotate the one you prefer or ask for changes."
```

### HTML pages

- Keep the page self-contained, or place relative assets (images, CSS, JS,
  fonts) **next to the HTML file**; Paperclip serves only allowlisted files in
  that directory. Never use absolute `/` asset paths.
- Write review pages into a dedicated directory such as `.lavish/`, never your
  home directory: sibling files of the page are reachable through its link.
- The page runs in a sandboxed frame without Paperclip cookies or API access.
- For interactive annotation, follow the `lavish` skill to build the page and
  pass `--lavish`. **Do not run `lavish-axi poll` yourself** for a Paperclip
  review: the server polls every minute and wakes you with the feedback.

## Receive feedback

You are woken with `PAPERCLIP_WAKE_REASON` set to one of:

- `review_feedback`: the user asked for changes or answered your question
  (typed in Paperclip, or annotations sent from Lavish). The wake message
  contains the feedback, the review id and the artifact path.
- `review_approved`: continue with the next step of the work.
- `review_closed`: the user closed it without approval. Do not continue that
  line of work unless asked.

Read the whole thread with `GET /api/reviews/{reviewId}`.

## Reply

1. Apply the feedback. Edit the same HTML file in place; Lavish and the
   Reviews page reload it.
2. Reply, which puts the review back in the user's queue and shows the reply
   in the Lavish conversation:

```bash
PAPERCLIP_API_BASE="${PAPERCLIP_API_URL%/}"; PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE%/api}"
curl -s -X POST "$PAPERCLIP_API_BASE/api/reviews/$REVIEW_ID/messages" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d '{"body":"Darkened the hero and fixed the footer typo.","readyForReview":true}'
```

Use `"readyForReview": false` for an interim note while you keep working.

Other updates: `PATCH /api/reviews/{reviewId}` with `title`, `summary`,
`kind`, a new `filePath`/`html`/`url`, or `status: "closed"` to withdraw a
review. Only the board can approve.

## Endpoints

| Method | Path | Who |
|---|---|---|
| GET | `/api/companies/{companyId}/reviews?status=open\|all\|pending_review\|changes_requested\|approved\|closed` | board, agents |
| GET | `/api/companies/{companyId}/reviews/summary` | board, agents |
| POST | `/api/companies/{companyId}/reviews` | board (`agentId` required), agents |
| GET | `/api/reviews/{reviewId}` | board, agents |
| PATCH | `/api/reviews/{reviewId}` | board; agents: content, `pending_review`, `closed` |
| POST | `/api/reviews/{reviewId}/messages` | board (feedback), agents (reply) |
| POST | `/api/companies/{companyId}/reviews/poll` | board: poll Lavish now |
