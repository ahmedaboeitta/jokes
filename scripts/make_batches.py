"""Build the annotation batches from source_data/.

Selection rule: items where at least 2 of the models predicted the wrong
harmful/safe label.
  text:   GPT-4o, GPT-5, Gemini 2.5 Pro, Gemini 3 Pro (2 of 4)
  videos: GPT-4o, GPT-5 Pro, Gemini 2.5 Pro, Gemini 3 Pro (2 of 4)
  images: GPT-4o, GPT-5.2, Gemini 2.5 Pro (2 of 3; a missing prediction
          counts as not wrong)
Universal videos (>=2 wrong) are split randomly in half between the English
and Arabic pools. Every pool item is used exactly once.

Batches, per language: 400 items = 100 text + 100 videos + 200 images. When
a type runs out, the gap is filled from images (then text, then videos), so
every batch has 400 items except the last one.

Outputs:
  batches/batch_0N/text/{english,arabic}.csv      public, what the site shows
  batches/batch_0N/videos/{english,arabic}.csv    (no labels in these files)
  batches/batch_0N/videos/files/*.mp4
  batches/batch_0N/images/{english,arabic}.csv
  batches/batch_0N/images/files/*
  batches/.gitignore                              keeps media of batches not
                                                  in LIVE_MEDIA out of git
  source_data/selection/batches_manifest.csv      private: true labels,
                                                  models-wrong counts, sources

Run from the repo root:  python3 scripts/make_batches.py
Re-running with the same SEED gives exactly the same batches.
"""

import csv
import os
import random
import shutil

SEED = 42
BATCH_SIZE = 400
QUOTA = {"text": 100, "videos": 100, "images": 200}
FILL_ORDER = ["images", "text", "videos"]
MIN_WRONG = 2

# Batches whose media (videos/images) is published. GitHub Pages caps the site
# at 1 GB, so only these batches' files/ folders are committed; the rest are
# listed in batches/.gitignore. The small CSVs of every batch are always
# committed (the Sheet's progress tab reads them). To swap batches: edit this
# list, re-run the script, commit, push.
LIVE_MEDIA = [1]

SRC = "source_data"
OUT = "batches"
MANIFEST = os.path.join(SRC, "selection", "batches_manifest.csv")

TEXT_MODELS = {
    "English": [
        "chatgpt-4o-latest/chatgpt-4o_english_jokes.csv",
        "gpt-5-2025-08-07/gpt-5_english_jokes.csv",
        "gemini-2.5-pro/gemini-2.5-pro_english_jokes.csv",
        "gemini-3-pro-preview/gemini_english_jokes_combined.csv",
    ],
    "Arabic": [
        "chatgpt-4o-latest/chatgpt-4o_arabic_jokes.csv",
        "gpt-5-2025-08-07/gpt-5_arabic_jokes.csv",
        "gemini-2.5-pro/gemini_arabic_jokes.csv",
        "gemini-3-pro-preview/FULL_gemini_arabic_jokes.csv",
    ],
}
# Joke text and true label are taken from this file (index into the lists
# above). The GPT-4o Arabic file has a slightly different copy of row 900.
TEXT_REFERENCE = 1  # gpt-5

VIDEO_MODELS = ["gpt4o.csv", "gpt5_pro.csv", "gemini2.5_pro.csv", "gemini3_pro.csv"]

IMAGE_MODELS = ["gpt4o.csv", "gpt5.2.csv", "gemini2.5_pro.csv"]
IMAGE_LANGUAGES = {"en": "English", "ar": "Arabic"}


def read_dicts(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def write_rows(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        csv.writer(f).writerows(rows)


def text_pool(lang):
    """[{item_id, item, true_label, explicit, models_wrong}] with >= MIN_WRONG wrong."""
    base = os.path.join(SRC, "text_data", "model_outputs", lang)
    outputs = [
        {r["row_id"]: r["Output_Class"].strip() for r in read_dicts(os.path.join(base, f))}
        for f in TEXT_MODELS[lang]
    ]
    ref = read_dicts(os.path.join(base, TEXT_MODELS[lang][TEXT_REFERENCE]))
    pool = []
    for r in ref:
        truth = r["Offensive"].strip()
        wrong = sum(o[r["row_id"]] != truth for o in outputs)
        if wrong >= MIN_WRONG:
            pool.append({
                "item_id": r["row_id"],
                "item": r["Jokes"],
                "true_label": truth,
                "explicit": r["Explicit"].strip(),
                "models_wrong": wrong,
                "source_language": lang,
            })
    return pool


def video_pools(rng):
    """{"English": [...], "Arabic": [...]} with Universal split in half."""
    labels = {}
    with open(os.path.join(SRC, "video_data", "labels.csv"), encoding="utf-8-sig", newline="") as f:
        for r in csv.reader(f):
            if r and r[0].strip().startswith("vid"):
                labels[r[0].strip()] = {
                    "true_label": r[1].strip(),
                    "explicit": r[2].strip(),
                    "language": r[3].strip(),
                }
    outputs = [
        {
            r["Video Name"].strip().replace(".mp4", ""): r["Harmful"].strip()
            for r in read_dicts(os.path.join(SRC, "video_data", "model_outputs", f))
        }
        for f in VIDEO_MODELS
    ]
    by_lang = {"English": [], "Arabic": [], "Universal": []}
    for vid, lab in labels.items():
        wrong = sum(o[vid] != lab["true_label"] for o in outputs)
        if wrong >= MIN_WRONG and lab["language"] in by_lang:
            by_lang[lab["language"]].append({
                "item_id": vid,
                "item": vid,
                "true_label": lab["true_label"],
                "explicit": lab["explicit"],
                "models_wrong": wrong,
                "source_language": lab["language"],
            })
    universal = sorted(by_lang["Universal"], key=lambda x: x["item_id"])
    rng.shuffle(universal)
    half = len(universal) // 2
    return {
        "English": by_lang["English"] + universal[:half],
        "Arabic": by_lang["Arabic"] + universal[half:],
    }


def image_pools():
    """{"English": [...], "Arabic": [...]} with >= MIN_WRONG of 3 wrong.

    labels.csv: post id, label (EXPLICIT / IMPLICIT / NO_DARK_HUMOUR), language.
    Harmful = EXPLICIT or IMPLICIT. Model files: path, label (harmful /
    non_harmful); a few images have no prediction from a model.
    """
    base = os.path.join(SRC, "image_data")
    outputs = [
        {r["path"].strip(): r["label"].strip().lower() for r in read_dicts(os.path.join(base, "model_outputs", f))}
        for f in IMAGE_MODELS
    ]
    pools = {"English": [], "Arabic": []}
    for r in read_dicts(os.path.join(base, "labels.csv")):
        pid, label = r["post id"].strip(), r["label"].strip()
        truth = "harmful" if label in ("EXPLICIT", "IMPLICIT") else "non_harmful"
        wrong = sum(pid in o and o[pid] != truth for o in outputs)
        lang = IMAGE_LANGUAGES[r["language"].strip()]
        if wrong >= MIN_WRONG:
            pools[lang].append({
                "item_id": pid,
                "item": pid,
                "true_label": 1 if truth == "harmful" else 0,
                "explicit": 1 if label == "EXPLICIT" else 0,
                "models_wrong": wrong,
                "source_language": lang,
                "label_3class": label,
            })
    return pools


def compose_batches(pools):
    """Cut {kind: shuffled list} into batches of BATCH_SIZE using QUOTA, and
    fill any shortfall in FILL_ORDER. Returns [{kind: [items]}, ...]."""
    left = {k: list(v) for k, v in pools.items()}
    batches = []
    while any(left.values()):
        take = {k: min(QUOTA[k], len(left[k])) for k in QUOTA}
        for k in FILL_ORDER:
            gap = BATCH_SIZE - sum(take.values())
            if gap <= 0:
                break
            take[k] += min(gap, len(left[k]) - take[k])
        batches.append({k: left[k][:n] for k, n in take.items()})
        left = {k: left[k][n:] for k, n in take.items()}
    return batches


def main():
    rng = random.Random(SEED)
    pools = {
        ("text", "English"): text_pool("English"),
        ("text", "Arabic"): text_pool("Arabic"),
    }
    vids = video_pools(rng)
    pools[("videos", "English")] = vids["English"]
    pools[("videos", "Arabic")] = vids["Arabic"]
    # Text and video pools are shuffled exactly as before images existed, so
    # their batches stay the same; images get their own random generator.
    for key in sorted(pools):
        pool = sorted(pools[key], key=lambda x: str(x["item_id"]))
        rng.shuffle(pool)
        pools[key] = pool
    img_rng = random.Random(SEED)
    for lang, pool in sorted(image_pools().items()):
        pool = sorted(pool, key=lambda x: x["item_id"])
        img_rng.shuffle(pool)
        pools[("images", lang)] = pool

    if os.path.isdir(OUT):
        shutil.rmtree(OUT)

    n_batches = 0
    manifest = [[
        "batch", "dataset", "item_index", "item_id", "item", "true_label",
        "explicit", "models_wrong", "source_language", "label_3class",
    ]]
    for lang in ("English", "Arabic"):
        lang_key = lang.lower()
        batches = compose_batches({k: pools[(k, lang)] for k in QUOTA})
        n_batches = max(n_batches, len(batches))
        for b, parts in enumerate(batches, start=1):
            print(f"{lang:7} batch_{b:02d}: " + ", ".join(f"{k} {len(parts[k])}" for k in QUOTA)
                  + f" = {sum(len(v) for v in parts.values())}")
            for kind, chunk in parts.items():
                if not chunk:
                    continue
                folder = os.path.join(OUT, f"batch_{b:02d}", kind)
                if kind == "text":
                    rows = [["item_id", "Jokes"]] + [[x["item_id"], x["item"]] for x in chunk]
                    dataset = lang_key
                else:
                    if kind == "videos":
                        rows = [["video_name"]] + [[x["item_id"]] for x in chunk]
                        src, ext = os.path.join(SRC, "video_data", "videos"), ".mp4"
                    else:
                        rows = [["post id"]] + [[x["item_id"]] for x in chunk]
                        src, ext = os.path.join(SRC, "image_data", "images"), ""
                    dataset = f"{kind}_{lang_key}"
                    os.makedirs(os.path.join(folder, "files"), exist_ok=True)
                    for x in chunk:
                        shutil.copy2(os.path.join(src, x["item_id"] + ext), os.path.join(folder, "files"))
                write_rows(os.path.join(folder, f"{lang_key}.csv"), rows)
                for i, x in enumerate(chunk):
                    manifest.append([
                        f"batch_{b:02d}", dataset, i, x["item_id"], x["item"], x["true_label"],
                        x["explicit"], x["models_wrong"], x["source_language"], x.get("label_3class", ""),
                    ])

    # Header-only CSVs for any track a batch doesn't have (pool ran out), so
    # the site shows "no items" instead of failing to load the file.
    headers = {"text": ["item_id", "Jokes"], "videos": ["video_name"], "images": ["post id"]}
    for b in range(1, n_batches + 1):
        for kind, header in headers.items():
            for lang_key in ("english", "arabic"):
                path = os.path.join(OUT, f"batch_{b:02d}", kind, f"{lang_key}.csv")
                if not os.path.exists(path):
                    write_rows(path, [header])

    with open(os.path.join(OUT, ".gitignore"), "w") as f:
        f.write("# Written by scripts/make_batches.py (LIVE_MEDIA). Media of batches that\n"
                "# aren't live is kept out of git to stay under the 1 GB Pages limit.\n")
        for b in range(1, n_batches + 1):
            if b not in LIVE_MEDIA:
                f.write(f"/batch_{b:02d}/*/files/\n")

    write_rows(MANIFEST, manifest)
    print(f"manifest: {MANIFEST} ({len(manifest) - 1} items)")


if __name__ == "__main__":
    main()
