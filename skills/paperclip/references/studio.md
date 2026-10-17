# Studio Catalog (`/studio`)

**Studio** is the board user's persistent production catalog for finalized, approved assets across runs.

## Strict Separation: Reviews vs. Studio Catalog

- **Board Reviews (`/reviews` page and Lavish)**: For draft iterations, visual comparisons needing Lavish annotations, and open decisions (`paperclip-submit-review.sh --lavish`). Reviews include interactive Lavish chrome (comment pins, annotation toolbars, prompt queues) for exploratory review rounds.
- **Studio Catalog (`/studio` page)**: Strictly for **finalized, polished production assets** (voices, SFX libraries, approved art styles/mascots, rendered episode cuts, design bible) with **zero Lavish chrome** so the user can select active assets for the next production phase (`paperclip-publish-studio.sh`).

Studio pages must remain clean, distraction-free production showrooms without annotation overlays or draft markers.

## Categories

- `voices_sound`: approved narration voices (Kokoro, Qwen VoiceDesign), curated sound-effect libraries, and master audio palettes
- `art_mascots`: approved mascot identity concepts, character turnarounds, production art bibles, and visual keys
- `episodes`: rendered episode cuts, approved hooks, animatics, and production phase gates
- `decisions`: canonical design decisions, audience territories, and conversion briefs

Unlike **Reviews** (`/reviews`), which is a transient approval queue, **Studio**
pages are **persistent and keyed by `slug`**. Publishing to the same `slug`
updates the page and copies its HTML + sibling media (`media/*.wav`, `.mp4`,
`.png`, `.svg`, `.json`) into the shared instance folder:

`~/.paperclip/instances/default/studio/<slug>/index.html`

## Publish or update a Studio page

Publish finalized assets directly with `paperclip-publish-studio.sh`. Do **not** pass `--lavish`:

```bash
bash "$paperclip_skill_dir/scripts/paperclip-publish-studio.sh" studio/voices.html \
  --slug voices-sound \
  --category voices_sound \
  --title "Voices & Sound Studio Catalog" \
  --summary "Finalized narration voices and procedural SFX palette for Episode 001." \
  --choices-json '[{"id":"af_heart","label":"Kokoro · af_heart","group":"Narration Voices"},{"id":"qwen-0","label":"Qwen · Warm storyteller (qwen-0)","group":"Narration Voices"}]'
```

## In-Page Interactive Selection (`window.paperclipStudio.select`)

Polished Studio pages can provide interactive cards, audio players, or gallery pickers directly in the page UI. To let the user select active choices from the page with zero Lavish chrome, call `window.paperclipStudio.select('<choice>')`:

```javascript
// Select an active choice by option id or label:
window.paperclipStudio.select('af_heart');
```

Paperclip automatically injects `window.paperclipStudio` into Studio HTML pages served via `/api/studio-content/*`:

```javascript
window.paperclipStudio = {
  select: function(choice) {
    window.parent.postMessage({ type: "paperclip:studio-select", choice: String(choice || "") }, "*");
  }
};
```

For standalone preview outside Paperclip or custom wrappers, pages can declare the fallback safely:

```html
<script>
window.paperclipStudio = window.paperclipStudio || {
  select(choice) {
    try {
      window.parent.postMessage({ type: "paperclip:studio-select", choice: String(choice || "") }, "*");
    } catch (e) {}
  }
};
</script>
```

When `window.paperclipStudio.select('<choice>')` executes:
1. The parent Studio shell receives `paperclip:studio-select` and toggles the asset active for the next phase.
2. Paperclip persists the selection to `~/.paperclip/instances/default/studio/<slug>/choice.json` and `choices.json`.

## Reading the user's persistent choices

When the board user saves a choice on a Studio page:

1. Paperclip updates `selectedChoices`, `choiceNotes`, and `selectionStatus = "choice_made"` on the Studio page.
2. Paperclip writes the choice to disk at:
   - `~/.paperclip/instances/default/studio/<slug>/choice.json`
   - `~/.paperclip/instances/default/studio/choices.json` (all Studio pages)
3. Paperclip wakes the responsible agent with `PAPERCLIP_WAKE_REASON=studio_choice`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/companies/{companyId}/studio?category=all|voices_sound|art_mascots|episodes|decisions|other` | List Studio pages, category counts, and shared `studioRootDir` |
| `POST` | `/api/companies/{companyId}/studio` | Upsert a Studio page by `slug` and sync its HTML + sibling media into `studio/<slug>/` |
| `GET` | `/api/studio/{pageId}` | Fetch a single Studio page |
| `PATCH` | `/api/studio/{pageId}/choice` | Record the user's `selectedChoices` and `choiceNotes` and optionally wake the responsible agent |
