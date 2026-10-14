/* =====================================================================
 * shared.js — shared by the service worker (importScripts) and dashboard.
 * Categories, schema defaults, storage helpers, strict parser, Levenshtein,
 * Google URL helpers, column helpers, mapping merge. No DOM access here.
 * ===================================================================== */

/* The 12 EXACT category keys (Module 2.3). */
const CATEGORIES = [
  "Character Names", "Titles/Honorifics", "Professions/Ranks", "Guild Names",
  "Organization Names", "Place Names", "Skill Names", "Ability Names",
  "Item Names", "System/Cultivation Levels", "Sound Effects (SFX)", "Other Terms"
];

/* The 5 split inputs per category (Module 2.4). */
const MAP_FIELDS = [
  { key: "sourceCol", label: "Source col", kind: "col" },
  { key: "targetCol", label: "Target col", kind: "col" },
  { key: "notesCol",  label: "Notes col",  kind: "col" },
  { key: "startRow",  label: "Start row",  kind: "row" },
  { key: "endRow",    label: "End row",    kind: "row", optional: true }
];

/* ---------- Data schema (Module 1) ----------
 * templates: { id, name, logoBase64, targetPreviewUrl, mappings: { [cat]: {sourceCol,targetCol,notesCol,startRow,endRow} } }
 * folders:   { id, parentId, name, logoBase64 }
 * files:     { id, folderId, name, logoBase64, targetLiveUrl, boundAccountEmail, customLinks:[{title,url}], templateId, overriddenMappings:{} }
 * queue:     { id, category, source, target, notes, timestamp, lang, raw }
 * snapshots: { [templateId|fileId]: { b64, fetchedAt, size } }   (offline .xlsx)
 * accounts:  [{ index, email }]  (last detection result)
 */
const DEFAULT_STATE = {
  templates: [], folders: [], files: [], queue: [],
  snapshots: {}, accounts: [], logs: [], stats: [],
  settings: { theme: "dark", monitor: true, closeTabAfterFill: true }
};

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

async function loadState() {
  const raw = await chrome.storage.local.get(Object.keys(DEFAULT_STATE));
  const s = {};
  for (const k of Object.keys(DEFAULT_STATE)) s[k] = raw[k] ?? structuredClone(DEFAULT_STATE[k]);
  s.settings = { ...DEFAULT_STATE.settings, ...s.settings };
  return s;
}
const saveState = (partial) => chrome.storage.local.set(partial);

async function addLog(level, message, extra = {}) {
  const { logs = [] } = await chrome.storage.local.get("logs");
  logs.unshift({ id: uid(), ts: Date.now(), level, message, ...extra });
  await chrome.storage.local.set({ logs: logs.slice(0, 2000) });
}
async function addStat(type, extra = {}) {
  const { stats = [] } = await chrome.storage.local.get("stats");
  stats.push({ ts: Date.now(), type, ...extra });
  await chrome.storage.local.set({ stats: stats.slice(-20000) });
}

/* =====================================================================
 * STRICT PARSER (Module 4)
 *   * Category: - [KR/CH/JP/ID] "Source" → "Target (Notes)"
 * The category can be the label on the line itself ("* Term: - [KR] …") or a
 * heading above a block ("**12. Other Terms**", "* Item Names:"). Markdown
 * bold markers are stripped first, so the prompt's output parses verbatim.
 * Notes may be in (parentheses) or [brackets] at the end of the target.
 * MISSING-PAIR RULE: source without target, or target without source,
 * is SKIPPED and reported — never queued.
 * ===================================================================== */
function parseGlossaryText(text) {
  const valid = [], skipped = [];
  let currentCategory = null;
  /* Leading label is optional; so is the leading bullet before it. The entry
     bullet may be a hyphen, an en/em dash or a bullet character. */
  const entryRe = /^\s*(?:[*•]?\s*([^:\n]+?)\s*:\s*)?[-–—*•]\s*\[([A-Za-z]{2}(?:\s*\/\s*[A-Za-z]{2})*)\]\s*(.*?)\s*(?:→|⇒|->|=>)\s*(.*?)\s*$/;
  const headingRe = /^[*#•\s]*(?:\d+\s*[.)]\s*)?([^:\n]+?)\s*:?\s*$/;
  const unquote = (s) => {
    s = String(s || "").trim();
    const m = s.match(/^["“”'']([\s\S]*?)["“”'']?$/);
    return (m ? m[1] : s).trim();
  };

  for (const original of String(text || "").split(/\r?\n/)) {
    if (!original.trim()) continue;
    // Markdown emphasis would break every pattern below.
    const line = original.replace(/\*\*|__/g, "").trim();
    if (!line) continue;

    const m = line.match(entryRe);
    if (!m) {
      /* A heading switches the category for the lines that follow — but only
         when it actually names one of the 12, so prose can't hijack a block. */
      const h = line.match(headingRe);
      const named = h && normalizeCategory(h[1]);
      if (named && CATEGORIES.includes(named)) { currentCategory = named; continue; }
      if (/[-–—•*]\s*\[[A-Za-z]{2}|→|⇒|->/.test(line)) skipped.push({ raw: original, reason: "Malformed line — no valid Source → Target pair" });
      continue;
    }
    const category = m[1] ? normalizeCategory(m[1]) : currentCategory;
    const lang = m[2].toUpperCase().replace(/\s/g, "");
    const source = unquote(m[3]);
    let target = unquote(m[4]), notes = "";
    // Notes = LAST trailing (...) or [...] chunk of the target.
    const nm = target.match(/^([\s\S]*?)\s*[\(\[]([^\)\]]*)[\)\]]\s*$/);
    if (nm) { target = nm[1].trim(); notes = nm[2].trim(); }
    target = target.replace(/^["“”']|["“”']$/g, "").trim();

    if (!source && !target) { skipped.push({ raw: original, reason: "Source and Target both missing" }); continue; }
    if (!source) { skipped.push({ raw: original, reason: "Source text MISSING (Target present)" }); continue; }
    if (!target) { skipped.push({ raw: original, reason: "Target text MISSING (Source present)" }); continue; }
    if (!category) { skipped.push({ raw: original, reason: "No category for this entry" }); continue; }
    if (!CATEGORIES.includes(category)) { skipped.push({ raw: original, reason: `Unknown category "${category}"` }); continue; }

    valid.push({ id: uid(), category, source, target, notes, lang, raw: original, timestamp: Date.now() });
  }
  return { valid, skipped };
}

/* =====================================================================
 * Category matching.
 * The 12-category prompt labels its lines in the SINGULAR ("* Term:",
 * "* Org Name:", "* System/Level Term:"), which never equals the canonical
 * plural name — so every label the prompt can emit is listed here, folded
 * onto its category. Keys are squashed, so case/punctuation/plurals in this
 * table don't matter.
 * ===================================================================== */
const CATEGORY_ALIASES = {
  "name": "Character Names", "character": "Character Names", "char": "Character Names",
  "character name": "Character Names", "person": "Character Names",
  "title": "Titles/Honorifics", "honorific": "Titles/Honorifics", "title/honorific": "Titles/Honorifics",
  "profession": "Professions/Ranks", "rank": "Professions/Ranks", "job": "Professions/Ranks",
  "occupation": "Professions/Ranks", "profession/rank": "Professions/Ranks",
  "guild": "Guild Names", "guild name": "Guild Names",
  "org": "Organization Names", "org name": "Organization Names", "organization": "Organization Names",
  "organisation": "Organization Names", "faction": "Organization Names",
  "clan": "Organization Names", "sect": "Organization Names",
  "place": "Place Names", "place name": "Place Names", "location": "Place Names",
  "skill": "Skill Names", "skill name": "Skill Names", "technique": "Skill Names",
  "ability": "Ability Names", "ability name": "Ability Names",
  "item": "Item Names", "item name": "Item Names", "object": "Item Names", "equipment": "Item Names",
  "system": "System/Cultivation Levels", "system level": "System/Cultivation Levels",
  "system/level term": "System/Cultivation Levels", "cultivation": "System/Cultivation Levels",
  "cultivation level": "System/Cultivation Levels", "level": "System/Cultivation Levels",
  "realm": "System/Cultivation Levels",
  "sfx": "Sound Effects (SFX)", "sound": "Sound Effects (SFX)",
  "sound effect": "Sound Effects (SFX)", "onomatopoeia": "Sound Effects (SFX)",
  "term": "Other Terms", "other": "Other Terms", "other term": "Other Terms",
  "misc": "Other Terms", "miscellaneous": "Other Terms", "general": "Other Terms"
};

/* "12. Other Terms", "other term" and "OTHER TERMS" all squash to "otherterm". */
function squashCategory(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/^\s*\d+\s*[.)]\s*/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.endsWith("ies") && w.length > 4 ? w.slice(0, -3) + "y"
            : w.endsWith("s") && w.length > 3 ? w.slice(0, -1) : w)
    .join("");
}

const CATEGORY_KEYS = Object.fromEntries([
  ...CATEGORIES.map(c => [squashCategory(c), c]),
  ...Object.entries(CATEGORY_ALIASES).map(([k, c]) => [squashCategory(k), c])
]);

/* Loose → canonical. "Term" → "Other Terms", "SFX" → "Sound Effects (SFX)" … */
function normalizeCategory(name) {
  const raw = String(name ?? "").trim();
  const k = squashCategory(raw);
  if (!k) return raw;
  if (CATEGORY_KEYS[k]) return CATEGORY_KEYS[k];

  /* Last resort for decorated labels ("Item/Equipment Names"). Only for
     label-sized strings: a sentence must never be read as a category. */
  if (raw.split(/\s+/).length <= 3) {
    let best = null;
    for (const [key, cat] of Object.entries(CATEGORY_KEYS)) {
      if (key.length < 4) continue;
      if ((k.includes(key) || key.startsWith(k)) && (!best || key.length > best.len)) best = { cat, len: key.length };
    }
    if (best) return best.cat;
  }
  return raw;
}

const LOOKS_LIKE_GLOSSARY = /[-–—•*]\s*\[[A-Za-z]{2}[^\]]*\][^\n]*(→|⇒|->|=>)/;

/* ---------- Levenshtein fuzzy dedupe ---------- */
function levenshtein(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const normTerm = (s) => String(s ?? "").toLowerCase().replace(/[\s"'“”.,!?·\-_]/g, "");
function similarity(a, b) {
  a = normTerm(a); b = normTerm(b);
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}
const DUP_THRESHOLD = 0.88;

/* ---------- Google URL helpers (inject /u/{index}/) ---------- */
function parseGoogleUrl(url) {
  const m = String(url).match(/docs\.google\.com\/(?:u\/\d+\/)?(spreadsheets|document)\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const gid = (String(url).match(/[#&?]gid=(\d+)/) || [])[1] || null;
  return { kind: m[1], id: m[2], gid };
}
function accountUrl(url, index, range) {
  const p = parseGoogleUrl(url);
  if (!p) return url;
  const base = `https://docs.google.com/${p.kind}/u/${index ?? 0}/d/${p.id}/edit`;
  const hash = [p.gid ? `gid=${p.gid}` : (range ? "gid=0" : null), range ? `range=${range}` : null].filter(Boolean).join("&");
  return hash ? `${base}#${hash}` : base;
}
function exportUrl(url, index) {
  const p = parseGoogleUrl(url);
  if (!p) return null;
  if (p.kind === "spreadsheets") return `https://docs.google.com/spreadsheets/u/${index ?? 0}/d/${p.id}/export?format=xlsx${p.gid ? `&gid=${p.gid}` : ""}`;
  return `https://docs.google.com/document/u/${index ?? 0}/d/${p.id}/export?format=docx`;
}

/* ---------- Columns ---------- */
function colToIndex(col) {
  let n = 0;
  for (const ch of String(col || "").toUpperCase().replace(/[^A-Z]/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function indexToCol(i) {
  let s = ""; i += 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

/* ---------- Template + override merge (Module 3.2) ----------
 * Overrides only store the fields the user changed for one file. */
function effectiveMappings(template, overrides) {
  const out = {};
  for (const c of CATEGORIES) {
    const merged = { ...(template?.mappings?.[c] || {}), ...(overrides?.[c] || {}) };
    for (const k of Object.keys(merged)) if (merged[k] === "" || merged[k] == null) delete merged[k];
    if (Object.keys(merged).length) out[c] = merged;
  }
  return out;
}

/* ---------- Base64 ---------- */
function bufToB64(buf) {
  const bytes = new Uint8Array(buf); let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64ToBuf(b64) {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
