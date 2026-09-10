# Jokes Harm Annotation Tool

A static, no-build-step web app for annotating a harmful-humor dataset
(jokes, images, videos) across English and Arabic. Hosted on GitHub Pages,
data saved locally per annotator (no backend).

- **Live site:** https://ahmedaboeitta.github.io/jokes/
- **Repo:** https://github.com/ahmedaboeitta/jokes (branch `main`; push = auto-deploy to Pages)
- **Git commits:** plain messages, no `Co-Authored-By: Claude` trailer (matches the user's preference in the sibling `hekayah` project).

## What this is

An annotator opens the site, enters a name/ID, picks a dataset track, and
works through items filling in a harm/humor schema per item. Progress
autosaves to `localStorage` per (name, dataset) so closing the tab and
coming back resumes where you left off. There is no server — annotators
export their work as JSON when done (`Export my annotations` button).

## File layout

- `index.html` / `app.js` / `style.css` — the annotation app.
- `docs.html` — standalone bilingual (EN | AR side-by-side) documentation
  of every schema field and its dropdown options.
- `data/*.csv` — per-dataset item lists. The `*_sample10.csv` files are the
  actual 10-per-language samples currently wired into the app (seeded
  `random.seed(42)`, reproducible). The full unsampled `english_jokes.csv`
  / `arabic_jokes.csv` are also here for future re-sampling.
- `media/images/`, `media/videos/` — the ~40 actual image/video files
  referenced by the sample CSVs (small, committed to git so the hosted
  site works).
- `image_data/`, `video_data/` — **git-ignored**. The full raw datasets
  (6,005 images / 1,202 videos, ~3GB total). Not needed by the live site,
  only for pulling new samples later. Shared with collaborators directly
  (not via git) since they're too large to push.

## Dataset tracks (dropdown on the setup screen)

| Key | Source | Type |
|---|---|---|
| `english` | `data/english_jokes_sample10.csv` | text |
| `arabic` | `data/arabic_jokes_sample10.csv` | text |
| `images_english` | `data/images_english_sample10.csv` | image |
| `images_arabic` | `data/images_arabic_sample10.csv` | image |
| `videos_english` | `data/videos_english_sample10.csv` | video |
| `videos_arabic` | `data/videos_arabic_sample10.csv` | video |

Config for each lives in `DATASETS` at the top of `app.js`. Adding a new
track is: add a CSV, add an entry to `DATASETS`, add an `<option>` to
`#language-select` in `index.html`.

## Annotation schema (10 fields, see `docs.html` for full descriptions)

`label`, `explicitness`, `harm_category`, `harm_culture`, `severity`,
`target`, `humor_mechanism`, `annotator_confidence`, `joke_summary`,
`why_harmful_or_safe`.

Key rule: **if `label` = Safe, then `harm_category`, `harm_culture`, and
`severity` auto-set to "Safe" and lock** (see `applySafeLock()` in
`app.js`) — a harmful-only field can't be filled in for a safe item.

## Localization

The Arabic dataset tracks (`arabic`, `images_arabic`, `videos_arabic`)
display the whole form in Arabic (RTL, Cairo font) via `data-en`/`data-ar`
attributes on every label/option/placeholder in `index.html`, swapped by
`applyLanguage()` in `app.js`. **Stored/exported values always stay the
English slugs** (e.g. `"harm_category": "racism_ethnicity_nationality"`)
regardless of which language was displayed — only the visible text
changes, not the underlying value.

## Known constraints / open items

- No backend and no GitHub push-back: annotations are export-only
  (JSON download). Two annotators using the same name/ID on different
  devices would each have separate local progress with no merge — not
  currently handled.
- Sample sizes are small (10 per language per track) — intended as a
  pilot/test set, not the full dataset. Re-sampling more requires editing
  the Python one-off scripts used originally (not currently saved as
  reusable files — recreate by reading each `*_sample10.csv`'s pattern).
