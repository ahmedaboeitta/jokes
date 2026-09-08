// Joke Harm Annotation Tool
// Static, no build step. Data loaded client-side from /data/*.csv.
// Progress is saved per (annotator, dataset) in localStorage, so closing the
// tab and coming back with the same name resumes where you left off.
// "Export" downloads all of that annotator's saved work as a JSON file.

const DATA_FILES = {
  english: "data/english_jokes_sample10.csv",
  arabic: "data/arabic_jokes_sample10.csv",
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
  lang: null,
  jokes: [],       // [{index, text}]
  annotations: {}, // index -> {label, explicitness, ...}
  currentIndex: 0,
};

const $ = (id) => document.getElementById(id);

function storageKey(annotator, lang) {
  return `jokes_annotations_v1__${lang}__${annotator}`;
}

function loadAnnotationsFromStorage(annotator, lang) {
  try {
    const raw = localStorage.getItem(storageKey(annotator, lang));
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error("Failed to read saved annotations", e);
    return {};
  }
}

function persistAnnotations() {
  try {
    localStorage.setItem(
      storageKey(state.annotator, state.lang),
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

async function startSession(annotator, lang) {
  state.annotator = annotator;
  state.lang = lang;

  const rows = await fetchCSV(DATA_FILES[lang]);
  state.jokes = rows.map((row, i) => ({ index: i, text: row.Jokes || "" }));
  state.annotations = loadAnnotationsFromStorage(annotator, lang);

  // Resume at the first un-annotated joke, or 0 if none started / all done.
  const firstUnannotated = state.jokes.findIndex(
    (j) => !state.annotations[j.index] || !state.annotations[j.index].label
  );
  state.currentIndex = firstUnannotated === -1 ? 0 : firstUnannotated;

  $("setup-screen").classList.add("hidden");
  $("annotation-screen").classList.remove("hidden");

  const jokeBox = $("joke-text");
  jokeBox.setAttribute("dir", lang === "arabic" ? "rtl" : "ltr");

  renderCurrent();
  updateProgress();
}

function renderCurrent() {
  const joke = state.jokes[state.currentIndex];
  $("joke-text").textContent = joke ? joke.text : "";
  $("index-text").textContent = `Joke ${state.currentIndex + 1} of ${state.jokes.length}`;

  const saved = state.annotations[joke.index] || {};
  for (const id of FIELD_IDS) {
    const el = $(`f-${id}`);
    const key = toCamel(id);
    el.value = saved[key] !== undefined ? saved[key] : "";
  }

  $("prev-btn").disabled = state.currentIndex === 0;
  $("next-btn").disabled = state.currentIndex === state.jokes.length - 1;
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
  entry.jokeIndex = joke.index;
  entry.jokeText = joke.text;
  entry.annotatedAt = new Date().toISOString();
  state.annotations[joke.index] = entry;
  persistAnnotations();
  updateProgress();
}

function updateProgress() {
  const total = state.jokes.length;
  const done = Object.values(state.annotations).filter((a) => a && a.label).length;
  $("progress-text").textContent = `${done} / ${total} annotated`;
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
    dataset: state.lang,
    updatedAt: new Date().toISOString(),
    annotations: Object.values(state.annotations),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sanitize(state.annotator)}_${state.lang}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitize(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

// --- wiring ---

$("start-btn").addEventListener("click", () => {
  const name = $("annotator-name").value.trim();
  const lang = $("language-select").value;
  if (!name) {
    alert("Please enter your name/ID.");
    return;
  }
  startSession(name, lang);
});

$("prev-btn").addEventListener("click", () => goTo(-1));
$("next-btn").addEventListener("click", () => goTo(1));

for (const id of FIELD_IDS) {
  $(`f-${id}`).addEventListener("change", saveCurrentFieldsToState);
}

$("switch-btn").addEventListener("click", () => {
  saveCurrentFieldsToState();
  $("annotation-screen").classList.add("hidden");
  $("setup-screen").classList.remove("hidden");
});

$("export-btn").addEventListener("click", exportJSON);
