// Joke Harm Annotation Tool
// Static, no build step. Data loaded client-side from /data/*.csv.
// Progress is saved per (annotator, dataset) in localStorage, so closing the
// tab and coming back with the same name resumes where you left off.
// "Export" downloads all of that annotator's saved work as a JSON file.

// Each dataset knows: where its CSV lives, whether items are jokes (text)
// or images, which CSV column holds the item, and which UI language
// (english/arabic) the annotation form should display in for that dataset.
const DATASETS = {
  english: {
    file: "data/english_jokes_sample10.csv",
    type: "text",
    itemColumn: "Jokes",
    uiLang: "english",
  },
  arabic: {
    file: "data/arabic_jokes_sample10.csv",
    type: "text",
    itemColumn: "Jokes",
    uiLang: "arabic",
  },
  images_english: {
    file: "data/images_english_sample10.csv",
    type: "image",
    itemColumn: "post id",
    mediaBase: "media/images/",
    uiLang: "english",
  },
  images_arabic: {
    file: "data/images_arabic_sample10.csv",
    type: "image",
    itemColumn: "post id",
    mediaBase: "media/images/",
    uiLang: "arabic",
  },
  videos_english: {
    file: "data/videos_english_sample10.csv",
    type: "video",
    itemColumn: "video_name",
    mediaBase: "media/videos/",
    mediaExt: ".mp4",
    uiLang: "english",
  },
  videos_arabic: {
    file: "data/videos_arabic_sample10.csv",
    type: "video",
    itemColumn: "video_name",
    mediaBase: "media/videos/",
    mediaExt: ".mp4",
    uiLang: "arabic",
  },
};

const FIELD_IDS = [
  "label",
  "explicitness",
  "harm-category",
  "harm-culture",
  "severity",
  "target",
  "humor-mechanism",
  "confidence",
  "joke-summary",
  "why",
];

let state = {
  annotator: null,
  datasetKey: null, // one of the DATASETS keys above
  jokes: [],        // [{index, text}] for text datasets, [{index, imageSrc}] for image datasets
  annotations: {},  // index -> {label, explicitness, ...}
  currentIndex: 0,
};

const $ = (id) => document.getElementById(id);

function currentDataset() {
  return DATASETS[state.datasetKey];
}

function storageKey(annotator, datasetKey) {
  return `jokes_annotations_v1__${datasetKey}__${annotator}`;
}

function loadAnnotationsFromStorage(annotator, datasetKey) {
  try {
    const raw = localStorage.getItem(storageKey(annotator, datasetKey));
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error("Failed to read saved annotations", e);
    return {};
  }
}

function persistAnnotations() {
  try {
    localStorage.setItem(
      storageKey(state.annotator, state.datasetKey),
      JSON.stringify(state.annotations)
    );
  } catch (e) {
    console.error("Failed to save annotations locally", e);
  }
}

function fetchCSV(path) {
  return new Promise((resolve, reject) => {
    Papa.parse(path, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (results) => resolve(results.data),
      error: reject,
    });
  });
}

async function startSession(annotator, datasetKey) {
  const dataset = DATASETS[datasetKey];
  state.annotator = annotator;
  state.datasetKey = datasetKey;

  const rows = await fetchCSV(dataset.file);
  state.jokes =
    dataset.type === "text"
      ? rows.map((row, i) => ({ index: i, text: row[dataset.itemColumn] || "" }))
      : rows.map((row, i) => ({
          index: i,
          mediaSrc: dataset.mediaBase + encodeURIComponent(row[dataset.itemColumn] || "") + (dataset.mediaExt || ""),
        }));
  state.annotations = loadAnnotationsFromStorage(annotator, datasetKey);

  // Resume at the first un-annotated joke, or 0 if none started / all done.
  const firstUnannotated = state.jokes.findIndex(
    (j) => !state.annotations[j.index] || !state.annotations[j.index].label
  );
  state.currentIndex = firstUnannotated === -1 ? 0 : firstUnannotated;

  $("setup-screen").classList.add("hidden");
  $("annotation-screen").classList.remove("hidden");

  applyLanguage(dataset.uiLang);
  renderCurrent();
  updateProgress();
}

// Swaps every translatable label/option/placeholder inside the annotation
// screen between English and Arabic, and sets text direction so the whole
// form (labels, dropdowns, buttons) mirrors correctly for Arabic. Option
// `value`s never change with language -- only the visible text does, so
// exported data always uses the same English slugs regardless of dataset.
function applyLanguage(lang) {
  const isArabic = lang === "arabic";
  const screen = $("annotation-screen");
  screen.setAttribute("dir", isArabic ? "rtl" : "ltr");
  screen.classList.toggle("lang-ar", isArabic);

  screen.querySelectorAll("[data-en]").forEach((el) => {
    el.textContent = isArabic ? el.dataset.ar : el.dataset.en;
  });
  screen.querySelectorAll("[data-en-placeholder]").forEach((el) => {
    el.placeholder = isArabic ? el.dataset.arPlaceholder : el.dataset.enPlaceholder;
  });
}

function renderCurrent() {
  const dataset = currentDataset();
  const joke = state.jokes[state.currentIndex];
  const isText = dataset.type === "text";
  const isImage = dataset.type === "image";
  const isVideo = dataset.type === "video";

  $("joke-text").classList.toggle("hidden", !isText);
  $("joke-image").classList.toggle("hidden", !isImage);
  $("joke-video").classList.toggle("hidden", !isVideo);

  if (isText) {
    $("joke-text").textContent = joke ? joke.text : "";
  } else if (isImage) {
    $("joke-image").src = joke ? joke.mediaSrc : "";
  } else if (isVideo) {
    $("joke-video").src = joke ? joke.mediaSrc : "";
    $("joke-video").load();
  }

  $("index-text").textContent =
    dataset.uiLang === "arabic"
      ? `العنصر ${state.currentIndex + 1} من ${state.jokes.length}`
      : `Item ${state.currentIndex + 1} of ${state.jokes.length}`;

  const saved = state.annotations[joke.index] || {};
  for (const id of FIELD_IDS) {
    const el = $(`f-${id}`);
    const key = toCamel(id);
    el.value = saved[key] !== undefined ? saved[key] : "";
  }
  applySafeLock();

  $("prev-btn").disabled = state.currentIndex === 0;
  $("next-btn").disabled = state.currentIndex === state.jokes.length - 1;
}

// Fields that don't apply once a joke is labeled Safe: force them to "safe"
// and lock them so the annotator can't fill in a harm category/culture/
// severity for something that isn't harmful. Unlocking (label != safe)
// clears any auto-set "safe" value so the annotator has to actively choose.
const SAFE_LOCKED_IDS = ["harm-category", "harm-culture", "severity"];

function applySafeLock() {
  const isSafe = $("f-label").value === "safe";
  for (const id of SAFE_LOCKED_IDS) {
    const el = $(`f-${id}`);
    if (isSafe) {
      el.value = "safe";
      el.disabled = true;
    } else {
      el.disabled = false;
      if (el.value === "safe") el.value = "";
    }
  }
}

function toCamel(kebab) {
  return kebab.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function saveCurrentFieldsToState() {
  const joke = state.jokes[state.currentIndex];
  const entry = state.annotations[joke.index] || {};
  for (const id of FIELD_IDS) {
    const el = $(`f-${id}`);
    const key = toCamel(id);
    entry[key] = el.value;
  }
  entry.itemIndex = joke.index;
  if (currentDataset().type === "text") {
    entry.itemText = joke.text;
  } else {
    entry.itemMedia = joke.mediaSrc;
  }
  entry.annotatedAt = new Date().toISOString();
  state.annotations[joke.index] = entry;
  persistAnnotations();
  updateProgress();
}

function updateProgress() {
  const total = state.jokes.length;
  const done = Object.values(state.annotations).filter((a) => a && a.label).length;
  $("progress-text").textContent =
    currentDataset().uiLang === "arabic"
      ? `تم وسم ${done} من ${total}`
      : `${done} / ${total} annotated`;
  $("progress-fill").style.width = total ? `${(done / total) * 100}%` : "0%";
}

function goTo(delta) {
  saveCurrentFieldsToState();
  const next = state.currentIndex + delta;
  if (next < 0 || next >= state.jokes.length) return;
  state.currentIndex = next;
  renderCurrent();
}

function exportJSON() {
  saveCurrentFieldsToState();
  const payload = {
    annotator: state.annotator,
    dataset: state.datasetKey,
    updatedAt: new Date().toISOString(),
    annotations: Object.values(state.annotations),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sanitize(state.annotator)}_${state.datasetKey}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitize(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

// --- wiring ---

$("start-btn").addEventListener("click", () => {
  const name = $("annotator-name").value.trim();
  const datasetKey = $("language-select").value;
  if (!name) {
    alert("Please enter your name/ID.");
    return;
  }
  startSession(name, datasetKey);
});

$("prev-btn").addEventListener("click", () => goTo(-1));
$("next-btn").addEventListener("click", () => goTo(1));

for (const id of FIELD_IDS) {
  $(`f-${id}`).addEventListener("change", () => {
    if (id === "label") applySafeLock();
    saveCurrentFieldsToState();
  });
}

$("switch-btn").addEventListener("click", () => {
  saveCurrentFieldsToState();
  $("annotation-screen").classList.add("hidden");
  $("setup-screen").classList.remove("hidden");
});

$("export-btn").addEventListener("click", exportJSON);
