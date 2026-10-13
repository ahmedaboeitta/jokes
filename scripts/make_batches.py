"""Build the annotation batches from source_data/.

Selection rule: items where at least 2 of the 4 models (GPT-4o, GPT-5 /
GPT-5 Pro, Gemini 2.5 Pro, Gemini 3 Pro) predicted the wrong harmful/safe
label. Universal videos (>=2 wrong) are split randomly in half between the
English and Arabic pools. From each pool, 100 items are picked at random and
split into 3 batches (34 / 33 / 33).

Outputs:
  batches/batch_0N/text/{english,arabic}.csv      public, what the site shows
  batches/batch_0N/videos/{english,arabic}.csv    (no labels in these files)
  batches/batch_0N/videos/files/*.mp4
  batches/batch_0N/images/{english,arabic}.csv    header only until image
                                                  model results exist
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
PER_TYPE = 100
N_BATCHES = 3
MIN_WRONG = 2

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


def split(items, n):
    """Split into n nearly equal consecutive chunks (34/33/33 for 100)."""
    size, extra = divmod(len(items), n)
    out, start = [], 0
    for i in range(n):
        end = start + size + (1 if i < extra else 0)
        out.append(items[start:end])
        start = end
    return out


def main():
    rng = random.Random(SEED)
    pools = {
        ("text", "English"): text_pool("English"),
        ("text", "Arabic"): text_pool("Arabic"),
    }
    vids = video_pools(rng)
    pools[("videos", "English")] = vids["English"]
    pools[("videos", "Arabic")] = vids["Arabic"]

    if os.path.isdir(OUT):
        shutil.rmtree(OUT)

    manifest = [[
        "batch", "dataset", "item_index", "item_id", "item", "true_label",
        "explicit", "models_wrong", "source_language",
    ]]
    for (kind, lang), pool in sorted(pools.items()):
        pool = sorted(pool, key=lambda x: str(x["item_id"]))
        picked = rng.sample(pool, PER_TYPE)  # random order too
        lang_key = lang.lower()
        dataset = lang_key if kind == "text" else f"videos_{lang_key}"
        print(f"{kind:6} {lang:7} pool={len(pool):3} picked={len(picked)}")
        for b, chunk in enumerate(split(picked, N_BATCHES), start=1):
            folder = os.path.join(OUT, f"batch_{b:02d}", kind)
            if kind == "text":
                rows = [["item_id", "Jokes"]] + [[x["item_id"], x["item"]] for x in chunk]
            else:
                rows = [["video_name"]] + [[x["item_id"]] for x in chunk]
                os.makedirs(os.path.join(folder, "files"), exist_ok=True)
                for x in chunk:
                    shutil.copy2(
                        os.path.join(SRC, "video_data", "videos", x["item_id"] + ".mp4"),
                        os.path.join(folder, "files"),
                    )
            write_rows(os.path.join(folder, f"{lang_key}.csv"), rows)
            for i, x in enumerate(chunk):
                manifest.append([
                    f"batch_{b:02d}", dataset, i, x["item_id"], x["item"], x["true_label"],
                    x["explicit"], x["models_wrong"], x["source_language"],
                ])

    # Images: placeholders until the image model results are available.
    for b in range(1, N_BATCHES + 1):
        for lang_key in ("english", "arabic"):
            write_rows(os.path.join(OUT, f"batch_{b:02d}", "images", f"{lang_key}.csv"), [["post id"]])

    write_rows(MANIFEST, manifest)
    print(f"manifest: {MANIFEST} ({len(manifest) - 1} items)")


if __name__ == "__main__":
    main()
