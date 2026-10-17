# Studio Showroom (`/studio`)

**Studio** is the board user's persistent showroom for comparing and choosing
creative/production options across runs:

- `voices_sound`: narration voice auditions (Kokoro, Qwen VoiceDesign), sound-effect libraries, and Sound Studio batches
- `art_mascots`: mascot identity concepts, character turnarounds, thumbnail comparisons, and visual art styles
- `episodes`: episode hooks, beat comparisons, and production gate selectors
- `decisions`: canonical design decisions, audience territories, and conversion briefs

Unlike **Reviews** (`/reviews`), which is a transient approval queue, **Studio**
pages are **persistent and keyed by `slug`**. Publishing to the same `slug`
updates the page and copies its HTML + sibling media (`media/*.wav`, `.mp4`,
`.png`, `.svg`, `.json`) into the shared instance folder:

`~/.paperclip/instances/default/studio/<slug>/index.html`

## Publish or update a Studio page

```bash
bash "$paperclip_skill_dir/scripts/paperclip-publish-studio.sh" .lavish/sound-review.html \
  --slug voices-sound-auditions \
  --category voices_sound \
  --title "Voices & Sound Studio Auditions" \
  --summary "Compare 6 narration voices and 12 procedural SFX samples." \
  --choices-json '[{"id":"af_heart","label":"Kokoro · af_heart","group":"Narration Voices"},{"id":"qwen-0","label":"Qwen · Warm storyteller (qwen-0)","group":"Narration Voices"}]' \
  --lavish
```

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
| `GET` | `/api/companies/{companyId}/studio?category=all\|voices_sound\|art_mascots\|episodes\|decisions\|other` | List Studio pages, category counts, and shared `studioRootDir` |
| `POST` | `/api/companies/{companyId}/studio` | Upsert a Studio page by `slug` and sync its HTML + sibling media into `studio/<slug>/` |
| `GET` | `/api/studio/{pageId}` | Fetch a single Studio page |
| `PATCH` | `/api/studio/{pageId}/choice` | Record the user's `selectedChoices` and `choiceNotes` and optionally wake the responsible agent |
