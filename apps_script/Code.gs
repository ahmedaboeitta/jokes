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
// It also builds tidy per-annotator CSV files in Drive (see buildFolders),
// nightly, and a "progress" tab (see refreshProgress), hourly. Both can be
// run from the Sheet menu "Annotations"; "Turn on automatic updates" sets
// up the triggers.

const MAX_FAILS = 10;           // failed logins per annotator before a lockout
const LOCKOUT_SECONDS = 15 * 60;

const ROOT_FOLDER_ID = "1ZW0XqFmVcg7jYZPDkr92MRdZanhns2lD"; // "jokes annotations"
const OUTPUT_FOLDER = "Annotations";
const NIGHTLY_HOUR = 2; // runs between 2 and 3 am, script time zone

// The public site: released batches are read from its app.js and item counts
// from its batch CSVs, so the progress tab never needs editing by hand.
const SITE_URL = "https://ahmedaboeitta.github.io/jokes/";

// Website dataset key -> language it belongs to.
const DATASET_LANGUAGE = {
  english: "english",
  arabic: "arabic",
  images_english: "english",
  images_arabic: "arabic",
  videos_english: "english",
  videos_arabic: "arabic",
};

// Website dataset key -> item CSV inside batches/batch_XX/ (as in app.js).
const DATASET_FILES = {
  english: "text/english.csv",
  arabic: "text/arabic.csv",
  images_english: "images/english.csv",
  images_arabic: "images/arabic.csv",
  videos_english: "videos/english.csv",
  videos_arabic: "videos/arabic.csv",
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
  ["item_id", (e) => e.itemId],
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
  ["annotated_at", (e) => e.annotatedAt],
  ["raw_json", (e) => JSON.stringify(e)],
];
const COLUMN_GETTERS = Object.fromEntries(COLUMNS);

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
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = annotationsSheet();
    // Rows follow the Sheet's own header, so adding or removing a column in
    // COLUMNS never shifts older rows. Columns no longer written stay empty.
    const header = annotationsHeader(sh);
    const rows = entries.map((entry) =>
      header.map((name) => (COLUMN_GETTERS[name] ? cell(COLUMN_GETTERS[name](entry, ctx)) : ""))
    );
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, saved: entries.length };
}

function load(req) {
  const auth = authenticate(req);
  if (auth.error) return auth.error;
  const langError = checkLanguage(auth.annotator, req.dataset);
  if (langError) return langError;
  const sh = annotationsSheet();
  const all = sh.getDataRange().getValues();
  const header = all[0];
  const values = all.slice(1);
  const col = (name) => header.indexOf(name);
  const [cId, cBatch, cDataset, cItem, cRaw] =
    ["annotator_id", "batch", "dataset", "item_id", "raw_json"].map(col);
  if (cItem === -1) return { ok: true, entries: [] };

  // Rows are appended in time order, so a later row overwrites an earlier one.
  // Old rows without an item_id are skipped.
  const latest = {};
  for (const r of values) {
    if (String(r[cId]) !== auth.annotator.id) continue;
    if (String(r[cBatch]) !== String(req.batch) || String(r[cDataset]) !== String(req.dataset)) continue;
    if (String(r[cItem]) === "") continue;
    try {
      latest[String(r[cItem])] = JSON.parse(r[cRaw]);
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
    .addItem("Refresh progress now", "refreshProgressFromMenu")
    .addItem("Turn on automatic updates", "installTriggers")
    .addToUi();
}

function buildFoldersFromMenu() {
  const n = buildFolders();
  SpreadsheetApp.getUi().alert("Done: " + n + " file(s) written to " + OUTPUT_FOLDER + "/.");
}

// Drive folders nightly, progress tab hourly. Safe to run again: old
// triggers for these functions are replaced, not duplicated.
function installTriggers() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (["buildFolders", "refreshProgress"].indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
    }
  }
  ScriptApp.newTrigger("buildFolders").timeBased().everyDays(1).atHour(NIGHTLY_HOUR).create();
  ScriptApp.newTrigger("refreshProgress").timeBased().everyHours(1).create();
  SpreadsheetApp.getUi().alert(
    "Automatic updates are on: folders every day around " + NIGHTLY_HOUR + ":00, progress every hour."
  );
}

function buildFolders() {
  const sh = annotationsSheet();
  const values = sh.getDataRange().getValues();
  const header = values[0];
  const rows = values.slice(1);
  const col = (name) => header.indexOf(name);
  const [cId, cBatch, cDataset, cItem, cIndex] =
    ["annotator_id", "batch", "dataset", "item_id", "item_index"].map(col);
  if (cItem === -1) return 0;
  // Only the current columns (old, no-longer-written ones are left out).
  const outCols = header.map((h, i) => i)
    .filter((i) => COLUMN_GETTERS[header[i]] && header[i] !== "raw_json");

  // Rows are in time order, so a later row replaces an earlier one.
  // Old rows without an item_id are left out.
  const groups = {};
  for (const r of rows) {
    if (!String(r[cId]) || String(r[cItem]) === "") continue;
    const g = [r[cId], r[cBatch], r[cDataset]].join("|");
    (groups[g] = groups[g] || {})[String(r[cItem])] = r;
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

// --- progress tab ---
// One row per active annotator x released batch x track of their language
// (tracks with no items yet are left out): done = items with a label,
// total = items in that batch's CSV on the site.

function refreshProgressFromMenu() {
  const n = refreshProgress();
  SpreadsheetApp.getUi().alert("Done: progress updated (" + n + " row(s)).");
}

function refreshProgress() {
  const batches = releasedBatches();

  // Items in each released batch/track.
  const totals = {};
  for (const batch of batches) {
    for (const dataset of Object.keys(DATASET_FILES)) {
      const url = SITE_URL + "batches/" + batch + "/" + DATASET_FILES[dataset];
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) continue;
      const rows = Utilities.parseCsv(res.getContentText("UTF-8"))
        .filter((r) => r.some((c) => String(c).trim()));
      totals[batch + "|" + dataset] = Math.max(rows.length - 1, 0);
    }
  }

  // Latest row per item; count the ones with a label.
  const values = annotationsSheet().getDataRange().getValues();
  const header = values[0].map(String);
  const col = (name) => header.indexOf(name);
  const [cId, cBatch, cDataset, cItem, cLabel] =
    ["annotator_id", "batch", "dataset", "item_id", "label"].map(col);
  const latest = {};
  if (cItem !== -1) {
    for (const r of values.slice(1)) {
      if (!String(r[cId]) || String(r[cItem]) === "") continue;
      latest[[r[cId], r[cBatch], r[cDataset], r[cItem]].join("|")] = String(r[cLabel]).trim() !== "";
    }
  }
  const done = {};
  for (const k of Object.keys(latest)) {
    if (!latest[k]) continue;
    const g = k.split("|").slice(0, 3).join("|");
    done[g] = (done[g] || 0) + 1;
  }

  const out = [["annotator", "language", "batch", "track", "done", "total", "%"]];
  for (const a of annotatorRows()) {
    if (!a.active) continue;
    for (const batch of batches) {
      for (const dataset of Object.keys(DATASET_FILES)) {
        if (DATASET_LANGUAGE[dataset] !== a.language) continue;
        const total = totals[batch + "|" + dataset];
        if (!total) continue;
        const n = done[[a.id, batch, dataset].join("|")] || 0;
        out.push([a.id, a.language, batch, DATASET_NAMES[dataset], n, total, n / total]);
      }
    }
  }

  let sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("progress");
  if (!sh) sh = SpreadsheetApp.getActiveSpreadsheet().insertSheet("progress");
  sh.clear();
  sh.getRange(1, 1, out.length, out[0].length).setValues(out);
  if (out.length > 1) sh.getRange(2, 7, out.length - 1, 1).setNumberFormat("0%");
  sh.getRange(1, 1, 1, out[0].length).setFontWeight("bold");
  sh.setFrozenRows(1);
  sh.getRange(1, 9, 1, 2).setValues([["last refreshed", new Date()]]);
  return out.length - 1;
}

// Batch folder names from RELEASED_BATCHES in the site's app.js.
function releasedBatches() {
  const js = UrlFetchApp.fetch(SITE_URL + "app.js").getContentText();
  const m = js.match(/RELEASED_BATCHES\s*=\s*\[([^\]]*)\]/);
  if (!m) throw new Error("RELEASED_BATCHES not found in app.js");
  return m[1].split(",").map((x) => x.trim()).filter(Boolean)
    .map((n) => "batch_" + ("0" + Number(n)).slice(-2));
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

// The header row, with any column from COLUMNS that's missing appended.
function annotationsHeader(sh) {
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const missing = COLUMNS.map(([n]) => n).filter((n) => header.indexOf(n) === -1);
  if (missing.length) {
    sh.getRange(1, header.length + 1, 1, missing.length).setValues([missing]);
    return header.concat(missing);
  }
  return header;
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
