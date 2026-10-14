# Jokes Harm Annotation Tool

A static, no-build-step web app for annotating a harmful-humor dataset
(jokes, images, videos) across English and Arabic. Hosted on GitHub Pages;
annotations are saved through a Google Apps Script backend into a private
Google Sheet.

- **Live site:** https://ahmedaboeitta.github.io/jokes/
- **Repo:** https://github.com/ahmedaboeitta/jokes (branch `main`; push = auto-deploy to Pages). The repo is **public**.
- **Git commits:** plain messages, no `Co-Authored-By: Claude` trailer (matches the user's preference in the sibling `hekayah` project).

## What this is

An annotator logs in (name from a dropdown + password), picks a batch and a
track in their language, and works through the items filling in a harm/humor
schema per item. Every change is kept in `localStorage` and auto-synced to the
Sheet, so work can be resumed from any device. `Export my annotations (JSON)`
downloads a backup copy.

## Architecture

```
GitHub Pages site (public)  →  Apps Script web app  →  Google Sheet + Drive (private)
```

- **Google Sheet "Annotations DB"** (private, owner only):
  https://docs.google.com/spreadsheets/d/1TfdLguarBB7gGzm-bB280ok5Xs1GoihNrpc5JDfpUaQ
  - `annotators`: `annotator_id | display_name | password | active | language` (language = `english`/`arabic`). Adding a row adds the annotator to the site dropdown, no push needed.
  - `annotations`: append-only; one row per save. The **latest row per (annotator, batch, dataset, item_id) is the current answer**; older rows are history. Includes all schema fields, `time_spent_sec`, and a `raw_json` copy of the entry. Rows are written by the Sheet's own header names (missing columns get appended), so old unused columns just stay empty. Old rows without `item_id` are ignored by load and export.
  - `log`: logins, bad passwords, lockouts, wrong-language attempts, errors.
- **Apps Script** (`apps_script/Code.gs` is the copy of record; it's pasted into the Sheet via Extensions → Apps Script). Deployed as a web app, Execute as: Me, Access: Anyone:
  https://script.google.com/macros/s/AKfycbyT7qIUSRt-SQX0Hbow3rRw99cymZJR3vmE7XqODja8Xodzewn8pAvihmomfOp72EAk1w/exec
  - Actions: `annotators`, `login`, `save`, `load`. The password is checked on **every** request (the URL is public in `app.js`). 10 wrong attempts lock the account for 15 minutes. Save/load refuse datasets outside the annotator's language.
  - **Updating the script without changing the URL:** Deploy → Manage deployments → Edit → Version: New version. ("New deployment" creates a new URL.)
  - Requests are POSTs with a text/plain body to avoid a CORS preflight.
- **Drive export:** `buildFolders()` writes
  `jokes annotations/Annotations/<English|Arabic>_annotators/<annotator_id>/<Language>_<Type>_batchXX.csv`
  (latest answer per item, overwritten each run). Run from the Sheet menu
  **Annotations → Build folders now**, and nightly (~2am) via the trigger set by
  **Annotations → Turn on nightly build**. Drive folder:
  https://drive.google.com/drive/folders/1ZW0XqFmVcg7jYZPDkr92MRdZanhns2lD
- **Passwords live only in the Sheet**, never in the repo.

## File layout

- `index.html` / `app.js` / `style.css`: the annotation app.
- `docs.html`: bilingual (EN | AR side-by-side) annotator docs: how the site works + every schema field and option.
- `apps_script/Code.gs`: backend code (see above).
- `batches/batch_XX/`: what the site shows (public). Per batch:
  `text/{english,arabic}.csv` (`item_id, Jokes`), `videos/{english,arabic}.csv` (`video_name`) + `videos/files/*.mp4`, `images/{english,arabic}.csv` (`post id`) + `images/files/`. **No true labels in these files** (they're public).
- `scripts/make_batches.py`: rebuilds `batches/` and the private manifest from `source_data/` (deletes and recreates `batches/`). Seeded, reproducible.
- `source_data/`: **git-ignored**, private raw research data (~3GB):
  - `text_data/jokes/{english,arabic}_jokes.csv`: original jokes.
  - `text_data/model_outputs/{English,Arabic}/<model>/*.csv`: 10 models' outputs (`row_id, Jokes, Offensive, Explicit, Output_Class, Output_Reason`).
  - `text_data/results/text_models_wrong.csv`.
  - `video_data/videos/*.mp4` (1,202), `video_data/labels.csv` (`Video Name, Inappropriate, Explicit, Language`; first 3 lines are headers/blank).
  - `video_data/model_outputs/{gpt4o,gpt5_pro,gemini2.5_pro,gemini3_pro}.csv` (`Video Name, Harmful, Evidence|Explanation`).
  - `video_data/results/videos_models_wrong.csv`.
  - `image_data/images/` (6,006 files), `image_data/labels.csv` (`post id, label, language`; 6,005 rows, one image unlabeled). No image model outputs yet.
  - `selection/batches_manifest.csv`: per batch item: true label, explicit, models_wrong, source_language.
- `Move from harmful.docx`: the user's research-plan notes (placement undecided).

## Sample selection (current batches)

- **Models (4):** GPT-4o, GPT-5 (text) / GPT-5 Pro (videos), Gemini 2.5 Pro, Gemini 3 Pro. The other 6 text models in `model_outputs/` are not used for selection.
  - Gemini 3 English official file: `gemini_english_jokes_combined.csv` (it differs from `FIRST_`/`SECOND_` on 38 answers).
  - Text true label = `Offensive`, taken from the GPT-5 file. The GPT-4o Arabic file has a slightly different copy of row 900 (label 0 vs 1); label 1 is used.
  - Video true label = `Inappropriate` in `labels.csv`.
- **Pool:** items where at least 2 of the 4 models were wrong (binary harmful/safe). English text 332, Arabic text 222; videos English 183 + Arabic 180 + Universal 184, with Universal split randomly in half → pools of 275 / 272.
- **Batches:** every pool item is used once, in random order (seed 42), cut into batches of **100 per type**; the last batch holds the rest:

  | Track | Pool | batch_01 | batch_02 | batch_03 | batch_04 |
  |---|---|---|---|---|---|
  | English text | 332 | 100 | 100 | 100 | 32 |
  | Arabic text | 222 | 100 | 100 | 22 | – |
  | English videos | 275 | 100 | 100 | 75 | – |
  | Arabic videos | 272 | 100 | 100 | 72 | – |
  | Images | pending | | | | |

  So a full batch = 100 text + 100 videos + 100 images per language.
- **Annotators are language-specific:** each annotator does their language's tracks; all annotators of a language get the same items (for agreement).
- Tracks a batch doesn't have (pool exhausted, or images pending) get header-only CSVs, and the site shows "no items yet".

## Releasing batches

`RELEASED_BATCHES` at the top of `app.js` lists the batches annotators can pick
(currently `[1]`). Releasing the next one (intended: every two weeks) = add its
number, commit, push.

## Dataset tracks

| Key | File (inside `batches/batch_XX/`) | Type | Language |
|---|---|---|---|
| `english` | `text/english.csv` | text | english |
| `arabic` | `text/arabic.csv` | text | arabic |
| `images_english` | `images/english.csv` | image | english |
| `images_arabic` | `images/arabic.csv` | image | arabic |
| `videos_english` | `videos/english.csv` | video | english |
| `videos_arabic` | `videos/arabic.csv` | video | arabic |

Config lives in `DATASETS` in `app.js`; the dataset → language map is
duplicated in `DATASET_LANGUAGE` in `Code.gs` (keep them in sync).

## Annotation schema (10 fields, see `docs.html` for full descriptions)

`label`, `explicitness`, `harm_category`, `harm_culture`, `severity`,
`target`, `humor_mechanism`, `annotator_confidence`, `joke_summary`,
`why_harmful_or_safe`.

Key rule: **if `label` = Safe, then `harm_category`, `harm_culture`, and
`severity` auto-set to "Safe" and lock** (see `applySafeLock()` in `app.js`).

## Timing (quality monitoring, recorded silently)

One value per item: `timeSpentSec` = total time the item was open on screen,
summed over every visit (timestamp-based, so browser timer throttling doesn't
affect it). Plus `annotatedAt`. Items only opened (no answers) are saved too,
with empty fields and their time.

## Sync details

Annotations are keyed by **item ID** (`item_id` for text, `video_name`,
`post id`), not by position, so rebuilding a batch can't attach an answer to a
different item. localStorage key: `jokes_annotations_v3__<batch>__<dataset>__<annotator>`.
The **Sync now** button in the top bar marks every entry of the open track
dirty and re-sends them all.

Entries carry local-only `_rev`/`_dirty` fields (stripped before sending).
Saves are debounced (2s) and retried every 15s on failure; `sendBeacon` on
tab hide/close. On session start, local and server copies are merged per
item and the newer `annotatedAt` wins. The password is held in memory only, so
a reload means logging in again.

## Localization

The Arabic tracks display the whole form in Arabic (RTL, Cairo font) via
`data-en`/`data-ar` attributes, swapped by `applyLanguage()`. **Stored values
are always the English slugs** regardless of display language. The setup
screen itself is English only.

## Known open items

- Image model results are not in yet, so the image tracks are empty.
- The `annotations` tab and Drive still contain test rows from user `hesham` (batches `test`, the old test `batch_02`), plus an old `Annotations/hesham/` folder from before the language folders existed.
- Once, a `load` was rejected as bad_credentials right after a successful login; not reproduced since.
