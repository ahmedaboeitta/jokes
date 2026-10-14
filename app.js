// Joke Harm Annotation Tool
// Static, no build step. Data loaded client-side from batches/batch_XX/.
// Annotators log in (ID + password, checked by the Apps Script backend in
// apps_script/Code.gs). Every save is kept in localStorage per
// (annotator, batch, dataset) and synced to the private Google Sheet, so work
// survives closing the tab and can be resumed from any device.
// "Export" downloads all of that annotator's saved work as a JSON file.

const API_URL =
  "https://script.google.com/macros/s/AKfycbyT7qIUSRt-SQX0Hbow3rRw99cymZJR3vmE7XqODja8Xodzewn8pAvihmomfOp72EAk1w/exec";

// Batches annotators can pick. All batches are prepared in batches/ up front;
// releasing the next one is just adding its number here and pushing.
const RELEASED_BATCHES = [1];

function batchFolder(n) {
  return `batch_${String(n).padStart(2, "0")}`;
}

// Each dataset knows: where its CSV lives (relative to the batch folder),
// whether items are jokes (text), images or videos, which CSV column holds
// the item, and which UI language (english/arabic) the form displays in.
const DATASETS = {
  english: {
    file: "text/english.csv",
    type: "text",
    itemColumn: "Jokes",
    idColumn: "item_id",
    uiLang: "english",
  },
  arabic: {
    file: "text/arabic.csv",
    type: "text",
    itemColumn: "Jokes",
    idColumn: "item_id",
    uiLang: "arabic",
  },
  images_english: {
    file: "images/english.csv",
    type: "image",
    itemColumn: "post id",
    idColumn: "post id",
    mediaBase: "images/files/",
    uiLang: "english",
  },
  images_arabic: {
    file: "images/arabic.csv",
    type: "image",
    itemColumn: "post id",
    idColumn: "post id",
    mediaBase: "images/files/",
    uiLang: "arabic",
  },
  videos_english: {
    file: "videos/english.csv",
    type: "video",
    itemColumn: "video_name",
    idColumn: "video_name",
    mediaBase: "videos/files/",
    mediaExt: ".mp4",
    uiLang: "english",
  },
  videos_arabic: {
    file: "videos/arabic.csv",
    type: "video",
    itemColumn: "video_name",
    idColumn: "video_name",
    mediaBase: "videos/files/",
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
  annotator: null,  // annotator ID from the Sheet
  password: null,   // kept in memory only, sent with every sync
  language: null,   // the annotator's language ("english"/"arabic"), from the Sheet
  batch: null,      // batch folder name, e.g. "batch_01"
  datasetKey: null, // one of the DATASETS keys above
  jokes: [],        // [{index, text}] for text datasets, [{index, imageSrc}] for image datasets
  annotations: {},  // index -> {label, explicitness, ...}
  currentIndex: 0,
  timing: null,     // per-visit timer for the item on screen (see startItemTimer)
};

const $ = (id) => document.getElementById(id);

function currentDataset() {
  return DATASETS[state.datasetKey];
}

function storageKey(annotator, batch, datasetKey) {
  return `jokes_annotations_v3__${batch}__${datasetKey}__${annotator}`;
}

function loadAnnotationsFromStorage(annotator, batch, datasetKey) {
  try {
    const raw = localStorage.getItem(storageKey(annotator, batch, datasetKey));
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error("Failed to read saved annotations", e);
    return {};
  }
}

function persistAnnotations() {
  try {
    localStorage.setItem(
      storageKey(state.annotator, state.batch, state.datasetKey),
      JSON.stringify(state.annotations)
    );
  } catch (e) {
    console.error("Failed to save annotations locally", e);
  }
}

// --- backend ---
// POST with a plain-text body so the browser skips the CORS preflight,
// which Apps Script can't answer.
async function api(action, body = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    body: JSON.stringify({ action, ...body }),
  });
  return res.json();
}

function credentials() {
  return { annotatorId: state.annotator, password: state.password };
}

// Entries carry two local-only fields: _rev (bumped on every save) and
// _dirty (not yet confirmed by the server). They're stripped before sending.
function cleanEntry(entry) {
  const { _rev, _dirty, ...rest } = entry;
  return rest;
}

const SYNC_DELAY_MS = 2000;
const RETRY_MS = 15000;
let syncTimer = null;
let syncing = false;

function scheduleSync(delay = SYNC_DELAY_MS) {
  if (delay === SYNC_DELAY_MS) setSyncStatus("saving");
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, delay);
}

async function syncNow() {
  if (syncing || !state.password) return;
  const dirty = Object.values(state.annotations).filter((a) => a && a._dirty);
  if (!dirty.length) return setSyncStatus("saved");
  const sent = dirty.map((a) => ({ id: a.itemId, rev: a._rev }));
  const ctx = { batch: state.batch, dataset: state.datasetKey };
  syncing = true;
  setSyncStatus("saving");
  try {
    const res = await api("save", { ...credentials(), ...ctx, entries: dirty.map(cleanEntry) });
    if (!res.ok) throw new Error(res.error);
    // Only clear entries that weren't edited again while the request was out,
    // and only if the annotator hasn't switched dataset meanwhile.
    if (ctx.batch === state.batch && ctx.dataset === state.datasetKey) {
      for (const { id, rev } of sent) {
        const a = state.annotations[id];
        if (a && a._rev === rev) a._dirty = false;
      }
      persistAnnotations();
    }
    syncing = false;
    const stillDirty = Object.values(state.annotations).some((a) => a && a._dirty);
    if (stillDirty) scheduleSync(); else setSyncStatus("saved");
  } catch (e) {
    console.error("Sync failed", e);
    syncing = false;
    setSyncStatus("error");
    scheduleSync(RETRY_MS);
  }
}

// Last-chance send when the tab is hidden or closed. The response can't be
// read, so entries stay dirty and are re-sent next time (the Sheet keeps the
// latest row per item, so a duplicate is harmless).
function beaconSync() {
  if (!state.password || !navigator.sendBeacon) return;
  const dirty = Object.values(state.annotations).filter((a) => a && a._dirty);
  if (!dirty.length) return;
  const body = JSON.stringify({
    action: "save", ...credentials(),
    batch: state.batch, dataset: state.datasetKey, entries: dirty.map(cleanEntry),
  });
  navigator.sendBeacon(API_URL, new Blob([body], { type: "text/plain" }));
}

const SYNC_TEXT = {
  saving: { english: "Saving…", arabic: "جارٍ الحفظ…" },
  saved: { english: "Saved ✓", arabic: "تم الحفظ ✓" },
  error: { english: "Not saved online – retrying", arabic: "لم يُحفظ على الإنترنت – إعادة المحاولة" },
};

function setSyncStatus(kind) {
  const el = $("sync-status");
  const lang = currentDataset() ? currentDataset().uiLang : "english";
  el.textContent = SYNC_TEXT[kind][lang];
  el.classList.toggle("sync-error", kind === "error");
}

// Combine what's on the server with what's in this browser: per item, the
// most recently saved version wins. Local-only or newer-local entries stay
// dirty so they get synced. Entries are keyed by item ID, so a rebuilt batch
// never attaches an answer to a different item; old rows without an ID are
// skipped.
function mergeAnnotations(local, remote) {
  const merged = { ...local };
  for (const r of remote) {
    if (!r.itemId) continue;
    const l = merged[r.itemId];
    if (!l || String(r.annotatedAt || "") >= String(l.annotatedAt || "")) {
      merged[r.itemId] = { ...r, _rev: (l && l._rev) || 0, _dirty: false };
    }
  }
  return merged;
}

async function loadAnnotators() {
  const select = $("annotator-select");
  try {
    const res = await api("annotators");
    if (!res.ok) throw new Error(res.error);
    select.innerHTML = '<option value="">-- select --</option>';
    for (const a of res.annotators) {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.name;
      select.appendChild(opt);
    }
  } catch (e) {
    console.error("Could not load annotators", e);
    select.innerHTML = '<option value="">(could not load)</option>';
    showSetupError("Could not reach the server. Check your internet connection and reload the page.");
  }
}

function showSetupError(msg) {
  $("setup-error").textContent = msg;
  $("setup-error").classList.toggle("hidden", !msg);
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

async function startSession(annotator, batch, datasetKey) {
  const dataset = DATASETS[datasetKey];
  const base = `batches/${batch}/`;
  state.annotator = annotator;
  state.batch = batch;
  state.datasetKey = datasetKey;

  const rows = await fetchCSV(base + dataset.file);
  if (!rows.length) throw new Error("empty_track");
  state.jokes =
    dataset.type === "text"
      ? rows.map((row, i) => ({ index: i, id: String(row[dataset.idColumn] || ""), text: row[dataset.itemColumn] || "" }))
      : rows.map((row, i) => ({
          index: i,
          id: String(row[dataset.idColumn] || ""),
          mediaSrc: base + dataset.mediaBase + encodeURIComponent(row[dataset.itemColumn] || "") + (dataset.mediaExt || ""),
        }));
  const local = loadAnnotationsFromStorage(annotator, batch, datasetKey);
  const remote = await api("load", { ...credentials(), batch, dataset: datasetKey });
  if (!remote.ok) throw new Error(remote.error);
  state.annotations = mergeAnnotations(local, remote.entries);
  persistAnnotations();

  // Resume at the first un-annotated joke, or 0 if none started / all done.
  const firstUnannotated = state.jokes.findIndex(
    (j) => !state.annotations[j.id] || !state.annotations[j.id].label
  );
  state.currentIndex = firstUnannotated === -1 ? 0 : firstUnannotated;

  $("setup-screen").classList.add("hidden");
  $("annotation-screen").classList.remove("hidden");

  applyLanguage(dataset.uiLang);
  renderCurrent();
  updateProgress();
  syncNow();
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

  const saved = state.annotations[joke.id] || {};
  for (const id of FIELD_IDS) {
    const el = $(`f-${id}`);
    const key = toCamel(id);
    el.value = saved[key] !== undefined ? saved[key] : "";
  }
  applySafeLock();

  startItemTimer();

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
  const entry = state.annotations[joke.id] || {};
  for (const id of FIELD_IDS) {
    const el = $(`f-${id}`);
    const key = toCamel(id);
    entry[key] = el.value;
  }
  entry.itemId = joke.id;
  entry.itemIndex = joke.index;
  if (currentDataset().type === "text") {
    entry.itemText = joke.text;
  } else {
    entry.itemMedia = joke.mediaSrc;
  }
  flushTiming(entry);
  entry.annotatedAt = new Date().toISOString();
  entry._rev = (entry._rev || 0) + 1;
  entry._dirty = true;
  state.annotations[joke.id] = entry;
  persistAnnotations();
  updateProgress();
  scheduleSync();
}

// --- per-item timing ---
// timeSpentSec on each entry = total time the item was open on screen,
// summed over every visit. Measured from timestamps, so it stays correct
// even when the browser slows down page timers. Time accumulates since the
// last flush, so saving mid-visit and again on leaving never double-counts.

function startItemTimer() {
  state.timing = { lastFlush: performance.now() };
}

function stopItemTimer() {
  state.timing = null;
}

function flushTiming(entry) {
  const t = state.timing;
  if (!t) return;
  const now = performance.now();
  entry.timeSpentSec = round1((entry.timeSpentSec || 0) + (now - t.lastFlush) / 1000);
  t.lastFlush = now;
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

document.addEventListener("visibilitychange", () => {
  if (state.timing && document.visibilityState === "hidden") {
    saveCurrentFieldsToState(); // don't lose time if the tab is closed while hidden
    beaconSync();
  }
});

window.addEventListener("pagehide", () => {
  if (state.timing) saveCurrentFieldsToState();
  beaconSync();
});

// Manual "Sync now": saves the item on screen and re-sends every entry of the
// open track, so the Sheet is guaranteed to have all of it (duplicates are
// harmless: the latest row per item wins).
function forceSync() {
  saveCurrentFieldsToState();
  for (const a of Object.values(state.annotations)) if (a) a._dirty = true;
  persistAnnotations();
  clearTimeout(syncTimer);
  syncNow();
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
    batch: state.batch,
    dataset: state.datasetKey,
    updatedAt: new Date().toISOString(),
    annotations: Object.values(state.annotations).map(cleanEntry),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sanitize(state.annotator)}_${state.batch}_${state.datasetKey}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitize(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

// --- wiring ---

for (const n of RELEASED_BATCHES) {
  const opt = document.createElement("option");
  opt.value = batchFolder(n);
  opt.textContent = `Batch ${n}`;
  $("batch-select").appendChild(opt);
}

loadAnnotators();

// The setup screen has two steps: log in, then pick batch + dataset. Only the
// datasets in the annotator's language are offered (the server enforces the
// same rule). Options are rebuilt rather than hidden, since Safari ignores
// `hidden` on <option>.
const ALL_DATASET_OPTIONS = [...$("language-select").options].map((o) => ({
  value: o.value,
  text: o.textContent,
}));

function showChooseStep(displayName) {
  const select = $("language-select");
  select.innerHTML = "";
  for (const o of ALL_DATASET_OPTIONS) {
    if (DATASETS[o.value].uiLang !== state.language) continue;
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.text;
    select.appendChild(opt);
  }
  $("welcome-text").textContent = `Logged in as ${displayName}`;
  $("login-step").classList.add("hidden");
  $("choose-step").classList.remove("hidden");
}

async function logIn() {
  const annotator = $("annotator-select").value;
  const password = $("annotator-password").value;
  if (!annotator || !password) {
    showSetupError("Please choose your name and enter your password.");
    return;
  }
  const btn = $("login-btn");
  btn.disabled = true;
  showSetupError("");
  try {
    const res = await api("login", { annotatorId: annotator, password });
    if (!res.ok) {
      showSetupError(
        res.error === "locked"
          ? "Too many wrong attempts. Please wait 15 minutes and try again."
          : "Wrong name or password."
      );
      return;
    }
    if (res.language !== "english" && res.language !== "arabic") {
      showSetupError("Your account has no language assigned yet. Please contact the project admin.");
      return;
    }
    state.annotator = annotator;
    state.password = password;
    state.language = res.language;
    showChooseStep(res.displayName);
  } catch (e) {
    console.error("Could not log in", e);
    showSetupError("Could not reach the server. Check your internet connection and try again.");
  } finally {
    btn.disabled = false;
  }
}

$("login-btn").addEventListener("click", logIn);
$("annotator-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") logIn();
});

$("logout-btn").addEventListener("click", () => {
  syncNow(); // send anything still pending while the credentials are known
  state.annotator = null;
  state.password = null;
  state.language = null;
  $("annotator-password").value = "";
  showSetupError("");
  $("choose-step").classList.add("hidden");
  $("login-step").classList.remove("hidden");
});

$("start-btn").addEventListener("click", async () => {
  const batch = $("batch-select").value;
  const datasetKey = $("language-select").value;
  const btn = $("start-btn");
  btn.disabled = true;
  showSetupError("");
  try {
    await startSession(state.annotator, batch, datasetKey);
  } catch (e) {
    console.error("Could not start session", e);
    showSetupError(
      e.message === "empty_track"
        ? "This track has no items in this batch yet."
        : "Could not load your saved work. Check your internet connection and try again."
    );
  } finally {
    btn.disabled = false;
  }
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
  syncNow();
  stopItemTimer();
  $("annotation-screen").classList.add("hidden");
  $("setup-screen").classList.remove("hidden");
});

$("export-btn").addEventListener("click", exportJSON);
$("sync-btn").addEventListener("click", forceSync);
