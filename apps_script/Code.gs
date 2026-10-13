// Jokes Annotation backend — Google Apps Script bound to the "Annotations DB" Sheet.
// Paste into Extensions → Apps Script, then Deploy → Web app
// (Execute as: Me, Who has access: Anyone).
//
// The Sheet stays private; this script is the only way in. Every write is
// checked against the annotator's password, and rows are append-only: the
// latest row per (annotator, batch, dataset, item) is the current answer,
// older rows are kept as history.
//
// Tabs: annotators (annotator_id | display_name | password | active | language),
//       annotations (headers written automatically), log.
//
// Requests from the website are POSTs with a text/plain JSON body (avoids a
// CORS preflight, which Apps Script can't answer). Actions:
//   annotators                         -> [{id, name}] of active annotators
//   login  {annotatorId, password}     -> {displayName, language}
//
// Each annotator works in one language (english/arabic, the "language"
// column); save/load refuse datasets of the other language.
//   save   {annotatorId, password, batch, dataset, entries: [entry, ...]}
//   load   {annotatorId, password, batch, dataset} -> {entries: [latest per item]}
//
// It also builds tidy per-annotator CSV files in Drive (see buildFolders):
// from the Sheet menu "Annotations", and nightly once the trigger is on.

const MAX_FAILS = 10;           // failed logins per annotator before a lockout
const LOCKOUT_SECONDS = 15 * 60;

const ROOT_FOLDER_ID = "1ZW0XqFmVcg7jYZPDkr92MRdZanhns2lD"; // "jokes annotations"
const OUTPUT_FOLDER = "Annotations";
const NIGHTLY_HOUR = 2; // runs between 2 and 3 am, script time zone

// Website dataset key -> language it belongs to.
const DATASET_LANGUAGE = {
  english: "english",
  arabic: "arabic",
  images_english: "english",
  images_arabic: "arabic",
  videos_english: "english",
  videos_arabic: "arabic",
};

// Website dataset keys -> file name prefix.
const DATASET_NAMES = {
  english: "English_Text",
  arabic: "Arabic_Text",
  images_english: "English_Images",
  images_arabic: "Arabic_Images",
  videos_english: "English_Videos",
  videos_arabic: "Arabic_Videos",
};

const COLUMNS = [
  ["received_at", (e, r) => r.receivedAt],
  ["annotator_id", (e, r) => r.annotatorId],
  ["batch", (e, r) => r.batch],
  ["dataset", (e, r) => r.dataset],
  ["item_index", (e) => e.itemIndex],
  ["item", (e) => e.itemText || e.itemMedia || ""],
  ["label", (e) => e.label],
  ["explicitness", (e) => e.explicitness],
  ["harm_category", (e) => e.harmCategory],
  ["harm_culture", (e) => e.harmCulture],
  ["severity", (e) => e.severity],
  ["target", (e) => e.target],
  ["humor_mechanism", (e) => e.humorMechanism],
  ["annotator_confidence", (e) => e.confidence],
  ["joke_summary", (e) => e.jokeSummary],
  ["why_harmful_or_safe", (e) => e.why],
  ["time_spent_sec", (e) => e.timeSpentSec],
  ["active_time_sec", (e) => e.activeTimeSec],
  ["visits", (e) => e.visits],
  ["first_opened_at", (e) => e.firstOpenedAt],
  ["annotated_at", (e) => e.annotatedAt],
  ["video_played", (e) => e.videoPlayed],
  ["video_watched_sec", (e) => e.videoWatchedSec],
  ["video_duration_sec", (e) => e.videoDurationSec],
  ["raw_json", (e) => JSON.stringify(e)],
];

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    switch (req.action) {
      case "annotators": return reply({ ok: true, annotators: listAnnotators() });
      case "login":      return reply(login(req));
      case "save":       return reply(save(req));
      case "load":       return reply(load(req));
      default:           return reply({ ok: false, error: "unknown_action" });
    }
  } catch (err) {
    log("error", "", String(err));
    return reply({ ok: false, error: "server_error" });
  }
}

function doGet() {
  return reply({ ok: true, service: "jokes-annotations" });
}

// --- auth ---

function listAnnotators() {
  return annotatorRows()
    .filter((a) => a.active)
    .map((a) => ({ id: a.id, name: a.name }));
}

function annotatorRows() {
  const values = sheet("annotators").getDataRange().getValues().slice(1);
  return values
    .filter((r) => String(r[0]).trim())
    .map((r) => ({
      id: String(r[0]).trim(),
      name: String(r[1]).trim() || String(r[0]).trim(),
      password: String(r[2]),
      active: r[3] === true || String(r[3]).trim().toUpperCase() === "TRUE",
      language: String(r[4] || "").trim().toLowerCase(),
    }));
}

// Returns the annotator record, or an error reply object.
function authenticate(req) {
  const id = String(req.annotatorId || "").trim();
  const cache = CacheService.getScriptCache();
  const failKey = "fails_" + id;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_FAILS) {
    log("locked", id, "");
    return { error: { ok: false, error: "locked" } };
  }
  const a = annotatorRows().find((x) => x.id === id);
  if (!a || !a.active || String(req.password || "") !== a.password) {
    cache.put(failKey, String(fails + 1), LOCKOUT_SECONDS);
    log("bad_login", id, req.action);
    return { error: { ok: false, error: "bad_credentials" } };
  }
  cache.remove(failKey);
  return { annotator: a };
}

function login(req) {
  const auth = authenticate(req);
  if (auth.error) return auth.error;
  log("login", auth.annotator.id, "");
  return { ok: true, displayName: auth.annotator.name, language: auth.annotator.language };
}

// Returns an error reply if the dataset isn't in the annotator's language.
function checkLanguage(annotator, dataset) {
  const lang = DATASET_LANGUAGE[dataset];
  if (lang && lang === annotator.language) return null;
  log("wrong_language", annotator.id, dataset);
  return { ok: false, error: "wrong_language" };
}

// --- data ---

function save(req) {
  const auth = authenticate(req);
  if (auth.error) return auth.error;
  const langError = checkLanguage(auth.annotator, req.dataset);
  if (langError) return langError;
  const entries = Array.isArray(req.entries) ? req.entries : [];
  if (!entries.length) return { ok: true, saved: 0 };

  const ctx = {
    receivedAt: new Date().toISOString(),
    annotatorId: auth.annotator.id,
    batch: String(req.batch || ""),
    dataset: String(req.dataset || ""),
  };
  const rows = entries.map((entry) => COLUMNS.map(([, get]) => cell(get(entry, ctx))));

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = annotationsSheet();
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, COLUMNS.length).setValues(rows);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, saved: rows.length };
}

function load(req) {
  const auth = authenticate(req);
  if (auth.error) return auth.error;
  const langError = checkLanguage(auth.annotator, req.dataset);
  if (langError) return langError;
  const sh = annotationsSheet();
  const values = sh.getDataRange().getValues().slice(1);
  const col = (name) => COLUMNS.findIndex(([n]) => n === name);
  const [cId, cBatch, cDataset, cIndex, cRaw] =
    ["annotator_id", "batch", "dataset", "item_index", "raw_json"].map(col);

  // Rows are appended in time order, so a later row overwrites an earlier one.
  const latest = {};
  for (const r of values) {
    if (String(r[cId]) !== auth.annotator.id) continue;
    if (String(r[cBatch]) !== String(req.batch) || String(r[cDataset]) !== String(req.dataset)) continue;
    try {
      latest[r[cIndex]] = JSON.parse(r[cRaw]);
    } catch (err) {
      // skip a damaged row rather than failing the whole load
    }
  }
  return { ok: true, entries: Object.values(latest) };
}

// --- Drive export ---
// Annotations/<Language>_annotators/<annotator>/<Language>_<Type>_batchXX.csv, one file per
// (annotator, batch, dataset), holding the latest answer per item. Files are
// overwritten in place on every run, so each is always the current version.

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Annotations")
    .addItem("Build folders now", "buildFoldersFromMenu")
    .addItem("Turn on nightly build", "installNightlyTrigger")
    .addToUi();
}

function buildFoldersFromMenu() {
  const n = buildFolders();
  SpreadsheetApp.getUi().alert("Done: " + n + " file(s) written to " + OUTPUT_FOLDER + "/.");
}

function installNightlyTrigger() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === "buildFolders") ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger("buildFolders").timeBased().everyDays(1).atHour(NIGHTLY_HOUR).create();
  SpreadsheetApp.getUi().alert("Nightly build is on (every day around " + NIGHTLY_HOUR + ":00).");
}

function buildFolders() {
  const sh = annotationsSheet();
  const values = sh.getDataRange().getValues();
  const header = values[0];
  const rows = values.slice(1);
  const col = (name) => header.indexOf(name);
  const [cId, cBatch, cDataset, cIndex] =
    ["annotator_id", "batch", "dataset", "item_index"].map(col);
  const outCols = header.map((h, i) => i).filter((i) => header[i] !== "raw_json");

  // Rows are in time order, so a later row replaces an earlier one.
  const groups = {};
  for (const r of rows) {
    if (!String(r[cId])) continue;
    const g = [r[cId], r[cBatch], r[cDataset]].join("|");
    (groups[g] = groups[g] || {})[r[cIndex]] = r;
  }

  const out = getOrCreateFolder(DriveApp.getFolderById(ROOT_FOLDER_ID), OUTPUT_FOLDER);
  const languageOf = {};
  for (const a of annotatorRows()) languageOf[a.id] = a.language;
  let written = 0;
  for (const g of Object.keys(groups)) {
    const [annotator, batch, dataset] = g.split("|");
    const items = Object.values(groups[g]).sort((a, b) => Number(a[cIndex]) - Number(b[cIndex]));
    const lines = [outCols.map((i) => header[i])]
      .concat(items.map((r) => outCols.map((i) => r[i])))
      .map((line) => line.map(csvField).join(","));
    // BOM so Excel opens Arabic text correctly.
    const csv = "\uFEFF" + lines.join("\r\n") + "\r\n";
    const langFolder = getOrCreateFolder(out, languageFolderName(languageOf[annotator]));
    writeFile(getOrCreateFolder(langFolder, annotator), fileName(batch, dataset), csv);
    written++;
  }
  return written;
}

function languageFolderName(language) {
  if (!language) return "Unassigned_annotators";
  return language.charAt(0).toUpperCase() + language.slice(1) + "_annotators";
}

function fileName(batch, dataset) {
  const name = DATASET_NAMES[dataset] || dataset;
  return name + "_" + String(batch).replace("batch_", "batch") + ".csv";
}

function getOrCreateFolder(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function writeFile(folder, name, content) {
  const it = folder.getFilesByName(name);
  if (it.hasNext()) it.next().setContent(content);
  else folder.createFile(name, content, MimeType.CSV);
}

function csvField(v) {
  if (v instanceof Date) v = v.toISOString();
  const s = String(v === null || v === undefined ? "" : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// --- helpers ---

function sheet(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error("Missing tab: " + name);
  return sh;
}

function annotationsSheet() {
  const sh = sheet("annotations");
  if (sh.getLastRow() === 0) {
    sh.appendRow(COLUMNS.map(([n]) => n));
    sh.setFrozenRows(1);
  }
  return sh;
}

// Stop free text that starts with = + - @ from being run as a Sheet formula.
function cell(v) {
  if (v === undefined || v === null) return "";
  if (typeof v === "string" && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

function log(event, annotatorId, detail) {
  try {
    const sh = sheet("log");
    if (sh.getLastRow() === 0) sh.appendRow(["time", "event", "annotator_id", "detail"]);
    sh.appendRow([new Date().toISOString(), event, annotatorId, cell(String(detail || ""))]);
  } catch (err) {
    // logging must never break a request
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
